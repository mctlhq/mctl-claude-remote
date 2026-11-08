// mctl-devloop: the orchestrator starts and reads DevLoop itself, as the ZITADEL machine user
// that mctl-api maps to service:mctl-orchestrator-devloop (mctlhq/mctl-api#963).
//
//   whoami   which principal mctl-api sees
//   start    preflight the issue on GitHub, then start its DevLoop on the Temporal path
//   get      read an issue's DevLoop
//
// There is no approve command, and there must never be one: approving a proposal is the
// operator's decision. mctl-api refuses the approve route for this principal anyway; the CLI
// not having one keeps a refusal from ever being the only thing in the way.
//
// The credential is an RSA key generated on this machine (0600, never copied anywhere). Each
// call signs a short JWT-profile assertion (RFC 7523) with it and exchanges that at ZITADEL for
// an access token of a few minutes. Neither the key nor a token is ever printed, logged or put
// in argv. The ids next to it (user, key, project) are not credentials: the operator copies
// them from the mctl-api/mctl-api-orchestrator-devloop-ids ConfigMap.
//
// Exit codes are mctl-publish's: 0 ok, 1 usage, 2 unreadable, 3 refused (nothing started),
// 4 outcome unknown. A start that may have happened is exit 4 and is not retried: read the
// loop with `get` first.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redact } from "./codexctl.ts";
import { GitHub, OutcomeUnknown, Refused, Unreadable, UsageError, config as publishConfig } from "./publish.ts";
import type { Config as PublishConfig } from "./publish.ts";

const ISSUE_URL = /^https:\/\/github\.com\/mctlhq\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]{0,9})$/;
const ISSUE_REF = /^mctlhq\/([A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})$/;
const ZITADEL_ID = /^[0-9]{1,32}$/;
const MAX_IDS_BYTES = 4096;
const ASSERTION_TTL_S = 120;

export type Config = {
  home: string;
  apiUrl: string;
  issuer: string;
  keyFile: string;
  idsFile: string;
  timeoutMs: number;
  github: PublishConfig;
};

export function config(env: Record<string, string | undefined> = process.env): Config {
  const home = env.MCTL_BRIDGE_HOME ?? path.join(os.homedir(), "mctl-bridge");
  return {
    home,
    apiUrl: env.MCTL_DEVLOOP_API_URL ?? "https://api.mctl.ai",
    issuer: env.MCTL_DEVLOOP_ISSUER ?? "https://auth.mctl.ai",
    keyFile: env.MCTL_DEVLOOP_KEY_FILE ?? path.join(home, "etc", "mctl-devloop-zitadel.pem"),
    idsFile: env.MCTL_DEVLOOP_IDS_FILE ?? path.join(home, "etc", "mctl-devloop.json"),
    timeoutMs: Number(env.MCTL_DEVLOOP_TIMEOUT_MS ?? 30_000),
    github: publishConfig(env),
  };
}

export type Issue = { repo: string; number: number; url: string; workflowId: string };

/** An issue as `mctlhq/<repo>#<n>` or its GitHub URL. Other owners are refused here. */
export function parseIssue(ref: string): Issue {
  const m = ISSUE_REF.exec(ref) ?? ISSUE_URL.exec(ref);
  if (!m) throw new UsageError(`--issue must be mctlhq/<repo>#<n> or https://github.com/mctlhq/<repo>/issues/<n>, not ${ref}`);
  const [, repo, n] = m as unknown as [string, string, string];
  // The same id mctl-api derives (temporalclient.WorkflowIDForIssueURL), case kept.
  return { repo, number: Number(n), url: `https://github.com/mctlhq/${repo}/issues/${n}`, workflowId: `dev-loop-mctlhq-${repo}-${n}` };
}

type Ids = { user_id: string; key_id: string; project_id: string };

export function readIds(file: string): Ids {
  let raw: Buffer;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > MAX_IDS_BYTES) throw new Error(`${st.size} bytes`);
    raw = fs.readFileSync(file);
  } catch (err) {
    throw new Unreadable(`the ids file ${file} cannot be read: ${(err as Error).message}`);
  }
  let d: any;
  try {
    d = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Unreadable(`the ids file ${file} is not JSON`);
  }
  for (const k of ["user_id", "key_id", "project_id"] as const) {
    if (typeof d?.[k] !== "string" || !ZITADEL_ID.test(d[k])) throw new Unreadable(`the ids file ${file} has no valid ${k}`);
  }
  return { user_id: d.user_id, key_id: d.key_id, project_id: d.project_id };
}

const b64u = (d: Buffer | string): string => Buffer.from(d).toString("base64url");

/** The scopes every token for mctl-api must carry (mctl-api docs/federation.md, ZITADEL). */
export function scopes(projectId: string): string {
  return `openid urn:zitadel:iam:org:project:id:${projectId}:aud urn:zitadel:iam:user:resourceowner`;
}

type Reply = { status: number; data: any };
class TransportError extends Error {}

export class MctlApi {
  private readonly cfg: Config;
  private cached: string | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private assertion(ids: Ids): string {
    let key: string;
    try {
      key = fs.readFileSync(this.cfg.keyFile, "utf8");
    } catch (err) {
      throw new Unreadable(`the DevLoop key cannot be read: ${(err as Error).message}`);
    }
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: ids.key_id }));
    const claims = b64u(JSON.stringify({ iss: ids.user_id, sub: ids.user_id, aud: this.cfg.issuer, iat: now, exp: now + ASSERTION_TTL_S }));
    let sig: string;
    try {
      sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${claims}`), key).toString("base64url");
    } catch (err) {
      throw new Unreadable(`the DevLoop key cannot sign: ${(err as Error).message}`);
    }
    return `${head}.${claims}.${sig}`;
  }

  private async fetchJson(method: string, url: string, init: { headers: Record<string, string>; body?: string }): Promise<Reply> {
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { "user-agent": "mctl-devloop", ...init.headers }, body: init.body, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (err) {
      throw new TransportError(`${method} ${url}: ${(err as Error).message}`);
    }
    const text = await res.text().catch(() => null);
    if (text === null) throw new TransportError(`${method} ${url}: the body was lost`);
    let data: any = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        throw new TransportError(`${method} ${url}: status ${res.status} with a malformed body`);
      }
    }
    return { status: res.status, data };
  }

  /** A fresh access token, kept for this one invocation only. */
  async token(): Promise<string> {
    if (this.cached) return this.cached;
    const ids = readIds(this.cfg.idsFile);
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: this.assertion(ids),
      scope: scopes(ids.project_id),
    });
    let r: Reply;
    try {
      r = await this.fetchJson("POST", `${this.cfg.issuer}/oauth/v2/token`, { headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() });
    } catch (err) {
      if (err instanceof TransportError) throw new Unreadable(err.message);
      throw err;
    }
    if (r.status !== 200 || typeof r.data?.access_token !== "string" || r.data.access_token === "") {
      // Only ZITADEL's error code: its description may echo request fields.
      throw new Unreadable(`no access token from ${this.cfg.issuer}: status ${r.status}${typeof r.data?.error === "string" ? ` (${r.data.error})` : ""}`);
    }
    this.cached = r.data.access_token as string;
    return this.cached;
  }

  /** A call to mctl-api. A transport failure throws TransportError for the caller to settle. */
  async call(method: string, p: string, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return this.fetchJson(method, this.cfg.apiUrl + p, { headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** A read: a transport failure, 5xx or anything unexpected is a failed read. */
  async read(p: string): Promise<Reply> {
    try {
      return await this.call("GET", p);
    } catch (err) {
      if (err instanceof TransportError) throw new Unreadable(err.message);
      throw err;
    }
  }
}

/** mctl-api's refusal of this principal: a 401 or 403 with nothing changed. */
function refusal(r: Reply): Refused | null {
  if (r.status === 401) return new Refused("unauthorized", "mctl-api did not accept the token");
  if (r.status === 403) return new Refused(typeof r.data?.code === "string" ? r.data.code : "forbidden", typeof r.data?.error === "string" ? r.data.error : "status 403");
  return null;
}

export async function whoami(api: MctlApi): Promise<Record<string, unknown>> {
  const r = await api.read("/api/v1/whoami");
  const no = refusal(r);
  if (no) throw no;
  if (r.status !== 200) throw new Unreadable(`GET /api/v1/whoami: status ${r.status}`);
  return { ok: true, whoami: r.data };
}

export async function get(api: MctlApi, issue: Issue): Promise<Record<string, unknown>> {
  const r = await api.read(`/api/v1/agents/dev-loop/${issue.workflowId}`);
  const no = refusal(r);
  if (no) throw no;
  // mctl-api's documented absence: 404 "workflow not found". Any other 404 is not proof.
  if (r.status === 404 && typeof r.data?.error === "string" && r.data.error.startsWith("workflow not found")) {
    return { ok: true, found: false, workflow_id: issue.workflowId };
  }
  if (r.status !== 200) throw new Unreadable(`GET dev-loop ${issue.workflowId}: status ${r.status}`);
  return { ok: true, found: true, workflow_id: issue.workflowId, loop: r.data };
}

/** Labels that keep an issue out of DevLoop (orchestrator AGENTS.md, "Starting DevLoop"). */
export function blockingLabel(names: string[]): { code: string; label: string } | null {
  for (const n of names) {
    const l = n.toLowerCase();
    if (l === "agents:intake") return { code: "preflight_intake", label: n };
    if (l.startsWith("steward:")) return { code: "preflight_steward", label: n };
    if (l === "epic" || l.startsWith("epic:") || l === "tracking") return { code: "preflight_epic", label: n };
    if (l === "hold" || l === "on-hold" || l.startsWith("hold:") || l === "blocked") return { code: "preflight_hold", label: n };
    if (l.startsWith("devloop") || l.startsWith("dev-loop")) return { code: "preflight_devloop", label: n };
  }
  return null;
}

/** The issue as GitHub has it now. Every check is on a successful read; a failed one is exit 2. */
export async function preflight(gh: GitHub, issue: Issue): Promise<void> {
  const d = await gh.read(`/repos/mctlhq/${issue.repo}/issues/${issue.number}`);
  if (d?.pull_request !== undefined) throw new Refused("preflight_pull_request", `${issue.url} is a pull request`);
  // GitHub follows a transferred issue or a renamed repository and matches
  // the repo name case-insensitively, so the issue read may not be the one
  // whose URL and workflow id start would use. Only its canonical URL counts.
  if (d?.html_url !== issue.url) throw new Refused("preflight_moved", `${issue.url} is at ${String(d?.html_url)}`);
  if (d?.state !== "open") throw new Refused("preflight_closed", `${issue.url} is ${String(d?.state)}`);
  if (!Array.isArray(d?.labels)) throw new Unreadable(`${issue.url}: no label list`);
  const names = d.labels.map((l: any) => (typeof l === "string" ? l : l?.name));
  if (names.some((n: unknown) => typeof n !== "string")) throw new Unreadable(`${issue.url}: a label without a name`);
  const hit = blockingLabel(names as string[]);
  if (hit) throw new Refused(hit.code, `${issue.url} carries the label ${hit.label}`);
}

export async function start(api: MctlApi, gh: GitHub, issue: Issue): Promise<Record<string, unknown>> {
  await preflight(gh, issue);
  // The server checks a live or finished loop itself and answers started:false; reading it
  // here as well would only race with that check.
  let r: Reply;
  try {
    r = await api.call("POST", "/api/v1/agents/dev-loop/start", { issue_url: issue.url });
  } catch (err) {
    if (err instanceof TransportError) throw new OutcomeUnknown(`the start of ${issue.workflowId} may or may not have happened: ${err.message}`);
    throw err;
  }
  const no = refusal(r);
  if (no) throw no;
  if (r.status === 400) throw new Refused("invalid_request", typeof r.data?.error === "string" ? r.data.error : "status 400");
  if (r.status === 202 && r.data?.started === true && r.data?.workflow_id === issue.workflowId) {
    return { ok: true, started: true, workflow_id: issue.workflowId, run_id: r.data.run_id, outcome: r.data.outcome };
  }
  if (r.status === 200 && r.data?.started === false && r.data?.workflow_id === issue.workflowId) {
    // Nothing new was started: a refusal, with the loop that is already there.
    throw new Refused(typeof r.data.outcome === "string" ? r.data.outcome : "not_started", `${issue.workflowId}: run ${String(r.data.run_id)}, status ${String(r.data.status)}`);
  }
  throw new OutcomeUnknown(`POST dev-loop/start for ${issue.workflowId}: status ${r.status}; read it with get before anything else`);
}

function args(argv: string[], valued: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!valued.includes(a)) throw new UsageError(`unknown argument ${a}`);
    const v = argv[++i];
    if (v === undefined || v === "") throw new UsageError(`${a} needs a value`);
    out[a] = v;
  }
  return out;
}

const USAGE = `usage: mctl-devloop whoami
       mctl-devloop start --issue mctlhq/<repo>#<n>
       mctl-devloop get --issue mctlhq/<repo>#<n>
Exit: 0 ok, 1 usage, 2 unreadable, 3 refused (nothing started), 4 outcome unknown.`;

export async function main(argv: string[], cfg: Config = config()): Promise<number> {
  const print = (v: unknown): void => void process.stdout.write(`${redact(JSON.stringify(v))}\n`);
  const api = new MctlApi(cfg);
  const gh = new GitHub(cfg.github);
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "whoami":
        args(rest, []);
        print(await whoami(api));
        return 0;
      case "start": {
        const a = args(rest, ["--issue"]);
        if (!a["--issue"]) throw new UsageError("--issue is required");
        print(await start(api, gh, parseIssue(a["--issue"])));
        return 0;
      }
      case "get": {
        const a = args(rest, ["--issue"]);
        if (!a["--issue"]) throw new UsageError("--issue is required");
        print(await get(api, parseIssue(a["--issue"])));
        return 0;
      }
      default:
        throw new UsageError(USAGE);
    }
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (err instanceof UsageError) {
      process.stderr.write(`${detail}\n`);
      return 1;
    }
    if (err instanceof Refused) return print({ ok: false, code: err.code, detail }), 3;
    if (err instanceof OutcomeUnknown) return print({ ok: false, code: "outcome_unknown", detail }), 4;
    return print({ ok: false, code: "unreadable", detail }), 2;
  } finally {
    await gh.revoke();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
