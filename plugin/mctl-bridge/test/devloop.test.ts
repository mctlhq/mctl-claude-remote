import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { blockingLabel, config, main, parseIssue, scopes } from "../src/devloop.ts";
import type { Config } from "../src/devloop.ts";

// Two keys: the GitHub App's (for the preflight read) and the DevLoop machine user's.
const app = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const dl = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const GH_TOKEN = "ghs_faketokenfaketokenfaketoken123456";
const ACCESS = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvcmNoZXN0cmF0b3IifQ.c2lnbmF0dXJlc2lnbmF0dXJl";
const IDS = { user_id: "111", key_id: "222", project_id: "333" };
const WF = "dev-loop-mctlhq-mctl-api-42";

type Fake = {
  calls: { method: string; path: string; body: any; auth: string }[];
  assertions: { head: any; claims: any; scope: string | null; grant: string | null }[];
  issue: any;
  tokenReply: { status: number; body: any };
  start: { status: number; body: any } | "drop";
  read: { status: number; body: any };
  whoami: { status: number; body: any };
  fail: Record<string, number>;
};

let server: ReturnType<typeof Bun.serve>;
let fake: Fake;
let tmp: string;
let cfg: Config;
const J = (d: unknown, status = 200): Response => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

function verifyAssertion(jwt: string): { head: any; claims: any } | null {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) return null;
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), dl.publicKey, Buffer.from(s, "base64url"))) return null;
  return { head: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(c, "base64url").toString()) };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-"));
  fs.writeFileSync(path.join(tmp, "app.pem"), app.privateKey.export({ type: "pkcs1", format: "pem" }) as string, { mode: 0o600 });
  fs.writeFileSync(path.join(tmp, "dl.pem"), dl.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const auth = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
      const text = await req.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      fake.calls.push({ method: req.method, path: url.pathname, body, auth });
      if (fake.fail[key] !== undefined) return J({ message: "fail" }, fake.fail[key]);
      if (key === "POST /oauth/v2/token") {
        const form = new URLSearchParams(text);
        const v = verifyAssertion(form.get("assertion") ?? "");
        if (!v) return J({ error: "invalid_grant" }, 400);
        fake.assertions.push({ ...v, scope: form.get("scope"), grant: form.get("grant_type") });
        return J(fake.tokenReply.body, fake.tokenReply.status);
      }
      if (key === "POST /app/installations/9/access_tokens") {
        const [h, c, s] = auth.split(".");
        if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), app.publicKey, Buffer.from(s!, "base64url"))) return J({}, 401);
        return J({ token: GH_TOKEN }, 201);
      }
      if (key === "DELETE /installation/token") return new Response(null, { status: 204 });
      // GitHub matches owner and repo case-insensitively, as here.
      if (key.toLowerCase() === "get /repos/mctlhq/mctl-api/issues/42") return auth === GH_TOKEN ? J(fake.issue) : J({}, 401);
      if (auth !== ACCESS) return J({ error: "unauthorized" }, 401);
      if (key === "GET /api/v1/whoami") return J(fake.whoami.body, fake.whoami.status);
      if (key === "POST /api/v1/agents/dev-loop/start") {
        if (fake.start === "drop") return new Response("{", { status: 202 });
        return J(fake.start.body, fake.start.status);
      }
      if (key === `GET /api/v1/agents/dev-loop/${WF}`) return J(fake.read.body, fake.read.status);
      return J({ error: "no route" }, 404);
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const env = { MCTL_BRIDGE_HOME: path.join(tmp, "home"), MCTL_PUBLISH_APP_ID: "1", MCTL_PUBLISH_INSTALLATION_ID: "9", MCTL_PUBLISH_KEY_FILE: path.join(tmp, "app.pem"), MCTL_PUBLISH_API_URL: base, MCTL_PUBLISH_TIMEOUT_MS: "5000" };
  cfg = { ...config(env), apiUrl: base, issuer: base, keyFile: path.join(tmp, "dl.pem"), idsFile: path.join(tmp, "ids.json"), timeoutMs: 5000 };
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(cfg.idsFile, JSON.stringify(IDS));
  fake = {
    calls: [],
    assertions: [],
    issue: { html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{ name: "bug" }] },
    tokenReply: { status: 200, body: { access_token: ACCESS, token_type: "Bearer", expires_in: 300 } },
    start: { status: 202, body: { workflow_id: WF, run_id: "r-1", started: true, outcome: "started" } },
    read: { status: 200, body: { workflow_id: WF, status: "Running" } },
    whoami: { status: 200, body: { user: "service:mctl-orchestrator-devloop" } },
    fail: {},
  };
});

async function run(...argv: string[]): Promise<{ code: number; out: any; raw: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => (chunks.push(String(s)), true);
  let code: number;
  try {
    code = await main(argv, cfg);
  } finally {
    (process.stdout as any).write = orig;
  }
  const raw = chunks.join("");
  return { code, out: raw.trim() ? JSON.parse(raw.trim().split("\n").pop()!) : null, raw };
}

const starts = (): number => fake.calls.filter((c) => c.path === "/api/v1/agents/dev-loop/start").length;

describe("mctl-devloop", () => {
  test("parseIssue takes mctlhq refs and URLs only, and derives mctl-api's workflow id", () => {
    expect(parseIssue("mctlhq/mctl-api#42")).toEqual({ repo: "mctl-api", number: 42, url: "https://github.com/mctlhq/mctl-api/issues/42", workflowId: WF });
    expect(parseIssue("https://github.com/mctlhq/mctl-api/issues/42").workflowId).toBe(WF);
    for (const bad of ["other/mctl-api#42", "mctlhq/mctl-api#0", "mctlhq/mctl-api#4x", "https://github.com/mctlhq/mctl-api/pull/42", "https://github.com/mctlhq/a/b/issues/1", "mctlhq/mctl-api#42 "]) {
      expect(() => parseIssue(bad)).toThrow();
    }
  });

  test("the assertion is signed by the DevLoop key, names this user and key, and asks for mctl-api's audience", async () => {
    const r = await run("whoami");
    expect(r.code).toBe(0);
    expect(fake.assertions).toHaveLength(1);
    const a = fake.assertions[0]!;
    expect(a.grant).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(a.head).toMatchObject({ alg: "RS256", kid: "222" });
    expect(a.claims).toMatchObject({ iss: "111", sub: "111", aud: cfg.issuer });
    expect(a.claims.exp - a.claims.iat).toBeLessThanOrEqual(300);
    expect(a.scope).toBe(scopes("333"));
    expect(a.scope).toContain("urn:zitadel:iam:org:project:id:333:aud");
    expect(a.scope).toContain("urn:zitadel:iam:user:resourceowner");
    expect(r.out).toMatchObject({ ok: true, whoami: { user: "service:mctl-orchestrator-devloop" } });
  });

  test("no token or key ever reaches stdout", async () => {
    fake.whoami = { status: 200, body: { echo: ACCESS } };
    const r = await run("whoami");
    expect(r.raw).not.toContain(ACCESS);
    expect(r.raw).not.toContain("PRIVATE KEY");
  });

  test("start: an open, unlabelled issue starts on the Temporal route with the canonical URL", async () => {
    const r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, started: true, workflow_id: WF, run_id: "r-1" });
    const call = fake.calls.find((c) => c.path === "/api/v1/agents/dev-loop/start")!;
    expect(call.body).toEqual({ issue_url: "https://github.com/mctlhq/mctl-api/issues/42" });
    expect(call.auth).toBe(ACCESS);
    expect(fake.calls.some((c) => c.path.includes("/approve") || c.path.includes("/operations/"))).toBe(false);
  });

  test("start: a ref whose case differs from GitHub's is refused, not started under another id", async () => {
    fake.calls = [];
    const r = await run("start", "--issue", "mctlhq/MCTL-API#42");
    expect({ code: r.code, out: r.out?.code }).toEqual({ code: 3, out: "preflight_moved" });
    expect(starts()).toBe(0);
  });

  test("start: the preflight refuses before anything is started", async () => {
    const cases: [any, string][] = [
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{ name: "agents:intake" }] }, "preflight_intake"],
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{ name: "steward:escalated" }] }, "preflight_steward"],
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{ name: "epic" }] }, "preflight_epic"],
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{ name: "hold" }] }, "preflight_hold"],
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{ name: "devloop:running" }] }, "preflight_devloop"],
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "closed", labels: [] }, "preflight_closed"],
      [{ html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [], pull_request: {} }, "preflight_pull_request"],
      [{ html_url: "https://github.com/mctlhq/mctl-agents/issues/7", state: "open", labels: [] }, "preflight_moved"],
      [{ state: "open", labels: [] }, "preflight_moved"],
    ];
    for (const [issue, code] of cases) {
      fake.calls = [];
      fake.issue = issue;
      const r = await run("start", "--issue", "mctlhq/mctl-api#42");
      expect({ code: r.code, out: r.out?.code }).toEqual({ code: 3, out: code });
      expect(starts()).toBe(0);
    }
  });

  test("start: an unreadable issue is exit 2, never an empty label list", async () => {
    fake.fail["GET /repos/mctlhq/mctl-api/issues/42"] = 502;
    let r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(2);
    expect(starts()).toBe(0);
    delete fake.fail["GET /repos/mctlhq/mctl-api/issues/42"];
    fake.issue = { html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open" };
    r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(2);
    fake.issue = { html_url: "https://github.com/mctlhq/mctl-api/issues/42", state: "open", labels: [{}] };
    r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(2);
    expect(starts()).toBe(0);
  });

  test("start: an existing loop is a refusal with its outcome, not a success", async () => {
    fake.start = { status: 200, body: { workflow_id: WF, run_id: "r-0", started: false, outcome: "already_running", status: "Running" } };
    const r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(3);
    expect(r.out.code).toBe("already_running");
  });

  test("start: mctl-api's refusal code is passed through", async () => {
    fake.start = { status: 403, body: { code: "orchestrator_devloop_repo_not_allowed", error: "not on the allow-list" } };
    const r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(3);
    expect(r.out.code).toBe("orchestrator_devloop_repo_not_allowed");
  });

  test("start: a lost reply, a 5xx or a reply for another workflow is outcome unknown", async () => {
    for (const s of ["drop", { status: 502, body: { error: "x" } }, { status: 503, body: { error: "x" } }, { status: 202, body: { workflow_id: "dev-loop-mctlhq-x-1", started: true } }, { status: 202, body: { workflow_id: WF } }] as const) {
      fake.start = s as any;
      const r = await run("start", "--issue", "mctlhq/mctl-api#42");
      expect({ s, code: r.code, out: r.out.code }).toEqual({ s, code: 4, out: "outcome_unknown" });
    }
  });

  test("a token that cannot be obtained is exit 2 and nothing is called", async () => {
    fake.tokenReply = { status: 400, body: { error: "invalid_grant", error_description: "secret-ish detail" } };
    const r = await run("start", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(2);
    expect(r.raw).not.toContain("secret-ish");
    expect(starts()).toBe(0);
    fake.tokenReply = { status: 200, body: { token_type: "Bearer" } };
    expect((await run("whoami")).code).toBe(2);
  });

  test("a missing or malformed ids file is exit 2", async () => {
    fs.rmSync(cfg.idsFile);
    expect((await run("whoami")).code).toBe(2);
    fs.writeFileSync(cfg.idsFile, JSON.stringify({ ...IDS, key_id: "22a" }));
    expect((await run("whoami")).code).toBe(2);
    fs.writeFileSync(cfg.idsFile, "{");
    expect((await run("whoami")).code).toBe(2);
    expect(fake.assertions).toHaveLength(0);
  });

  test("get: a loop, mctl-api's documented absence, and a failed read are three different answers", async () => {
    let r = await run("get", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ found: true, loop: { status: "Running" } });
    fake.read = { status: 404, body: { error: "workflow not found: " + WF } };
    r = await run("get", "--issue", "mctlhq/mctl-api#42");
    expect(r.out).toMatchObject({ ok: true, found: false });
    fake.read = { status: 404, body: { error: "no route" } };
    expect((await run("get", "--issue", "mctlhq/mctl-api#42")).code).toBe(2);
    fake.read = { status: 503, body: { error: "temporal" } };
    expect((await run("get", "--issue", "mctlhq/mctl-api#42")).code).toBe(2);
    fake.read = { status: 403, body: { code: "orchestrator_devloop_repo_not_allowed" } };
    r = await run("get", "--issue", "mctlhq/mctl-api#42");
    expect(r.code).toBe(3);
  });

  test("usage errors are exit 1 and there is no approve command", async () => {
    expect((await run("approve", "--issue", "mctlhq/mctl-api#42")).code).toBe(1);
    expect((await run("start")).code).toBe(1);
    expect((await run("start", "--issue", "other/x#1")).code).toBe(1);
    expect((await run("whoami", "--x", "1")).code).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });

  test("blockingLabel ignores ordinary labels", () => {
    expect(blockingLabel(["bug", "enhancement", "p2", "steward"])).toBeNull();
    expect(blockingLabel(["Agents:Intake"])?.code).toBe("preflight_intake");
  });

  test("config keeps the key and ids beside the App key", () => {
    const c = config({ MCTL_BRIDGE_HOME: "/h" });
    expect(c.keyFile).toBe("/h/etc/mctl-devloop-zitadel.pem");
    expect(c.idsFile).toBe("/h/etc/mctl-devloop.json");
    expect(c.apiUrl).toBe("https://api.mctl.ai");
    expect(c.issuer).toBe("https://auth.mctl.ai");
  });
});
