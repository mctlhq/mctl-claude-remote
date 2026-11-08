// mctl-publish: the orchestrator's hands on GitHub, as the mctl-codex GitHub App.
//
//   status   which App, which permissions, which repositories
//   publish  verify a slot's git bundle and manifest, push it unchanged, open a Draft PR;
//            with --update-from, fast-forward the App's own open PR instead
//   ready    mark a Draft PR ready for review
//   merge    merge a PR whose current head is approved by claude[bot] and fully green
//
// There is no approve command, and there must never be one. GitHub lets the App approve a
// PR written by somebody else, and such an approval satisfies the ruleset, so the only thing
// standing between Codex and a self-granted approval is that nothing here can produce one.
//
// A slot's bundle and manifest are untrusted input from another uid: they are opened without
// following symlinks and copied into a closed directory before anything reads them, and the
// manifest's claims are checked against the commits rather than believed.
//
// Git never sees the operator's credentials. The Mac mini keeps an admin login in the
// keychain, and git asks a credential helper before GIT_ASKPASS, so without
// `credential.helper=` a push would silently run as that admin and bypass the ruleset.
// The token reaches git through the environment, never through argv, since the slots share
// this machine and can read `ps`.
//
// A read that fails is exit 2 and never an empty list. A write whose outcome could not be
// established is exit 4: it is not retried, read the state first.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redact } from "./codexctl.ts";

export const REVIEW_BOT = "claude[bot]";
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const PASSING = new Set(["success", "neutral", "skipped"]);
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(feat|fix|ci|docs|chore|refactor|test)\/[A-Za-z0-9._/-]{1,100}$/;
const TASK = /^[A-Za-z0-9._-]{1,100}$/;

export class UsageError extends Error {}
/** GitHub or the local state could not be read: never to be taken for "nothing there". */
export class Unreadable extends Error {}
/** Checked and refused. Nothing was changed by this call. */
export class Refused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
/** A write was attempted and its outcome is not known. */
export class OutcomeUnknown extends Error {}

export type Config = {
  home: string;
  appId: string;
  installationId: string;
  keyFile: string;
  repos: string[];
  apiUrl: string;
  gitBase: string;
  timeoutMs: number;
};

export function config(env: Record<string, string | undefined> = process.env): Config {
  const home = env.MCTL_BRIDGE_HOME ?? path.join(os.homedir(), "mctl-bridge");
  return {
    home,
    appId: env.MCTL_PUBLISH_APP_ID ?? "5648595",
    installationId: env.MCTL_PUBLISH_INSTALLATION_ID ?? "179394531",
    keyFile: env.MCTL_PUBLISH_KEY_FILE ?? path.join(home, "etc", "codex-github-app.pem"),
    // Every repository the App is installed on except mctlhq/.github, which is nearly all workflow
    // files the App may not push (no workflows permission). Operator decision, 2026-11-07.
    repos: (env.MCTL_PUBLISH_REPOS ?? "mctlhq/mctl-claude-remote,mctlhq/bridge-step0-sandbox,mctlhq/mctl-telegram,mctlhq/mctl-gitops,mctlhq/mctl-api,mctlhq/mctl-agents,mctlhq/mctl-agent,mctlhq/mctl-web,mctlhq/mctl-docs,mctlhq/mctl-academy,mctlhq/mctl-alice,mctlhq/mctl-support,mctlhq/seerrsense").split(",").filter(Boolean),
    apiUrl: env.MCTL_PUBLISH_API_URL ?? "https://api.github.com",
    gitBase: env.MCTL_PUBLISH_GIT_BASE ?? "https://github.com",
    timeoutMs: Number(env.MCTL_PUBLISH_TIMEOUT_MS ?? 30_000),
  };
}

const b64u = (d: Buffer | string): string => Buffer.from(d).toString("base64url");

/** A reply that was received. A transport failure throws TransportError instead. */
type Reply = { status: number; data: any; next: string | null };
class TransportError extends Error {}

export class GitHub {
  private readonly cfg: Config;
  private cached: string | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private jwt(): string {
    let key: string;
    try {
      key = fs.readFileSync(this.cfg.keyFile, "utf8");
    } catch (err) {
      throw new Unreadable(`the App key cannot be read: ${(err as Error).message}`);
    }
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64u('{"alg":"RS256","typ":"JWT"}')}.${b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.cfg.appId }))}`;
    return `${body}.${crypto.sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
  }

  private async raw(method: string, url: string, auth: string, body?: unknown): Promise<Reply> {
    let res: Response;
    try {
      res = await fetch(url.startsWith("http") ? url : this.cfg.apiUrl + url, {
        method,
        headers: {
          authorization: `Bearer ${auth}`,
          accept: "application/vnd.github+json",
          "user-agent": "mctl-publish",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
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
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    return { status: res.status, data, next };
  }

  async token(): Promise<string> {
    if (this.cached) return this.cached;
    let r: Reply;
    try {
      r = await this.raw("POST", `/app/installations/${this.cfg.installationId}/access_tokens`, this.jwt(), {});
    } catch (err) {
      if (err instanceof TransportError) throw new Unreadable(err.message);
      throw err;
    }
    if (r.status !== 201 || typeof r.data?.token !== "string") throw new Unreadable(`no installation token: status ${r.status}`);
    this.cached = r.data.token as string;
    return this.cached;
  }

  /** Best effort: the token dies within an hour anyway. */
  async revoke(): Promise<void> {
    if (!this.cached) return;
    await this.raw("DELETE", "/installation/token", this.cached).catch(() => undefined);
    this.cached = null;
  }

  async app(): Promise<any> {
    return this.read("/app", this.jwt());
  }

  /** A read: anything but 200 is a failed read. */
  async read(p: string, auth?: string): Promise<any> {
    let r: Reply;
    try {
      r = await this.raw("GET", p, auth ?? (await this.token()));
    } catch (err) {
      if (err instanceof TransportError) throw new Unreadable(err.message);
      throw err;
    }
    if (r.status !== 200) throw new Unreadable(`GET ${p}: status ${r.status}`);
    return r.data;
  }

  /** Every page, or a failed read. A later page failing is not a shorter list. */
  async list(p: string, field?: string): Promise<any[]> {
    const out: any[] = [];
    let url: string | null = `${p}${p.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      let r: Reply;
      try {
        r = await this.raw("GET", url, await this.token());
      } catch (err) {
        if (err instanceof TransportError) throw new Unreadable(err.message);
        throw err;
      }
      if (r.status !== 200) throw new Unreadable(`GET ${url}: status ${r.status}`);
      const page = field ? r.data?.[field] : r.data;
      if (!Array.isArray(page)) throw new Unreadable(`GET ${url}: not a list`);
      if (r.next !== null && page.length === 0) throw new Unreadable(`GET ${url}: an empty page with a next link`);
      out.push(...page);
      if (field && typeof r.data?.total_count === "number" && r.next === null && out.length !== r.data.total_count) {
        throw new Unreadable(`GET ${url}: ${out.length} of ${r.data.total_count} entries`);
      }
      url = r.next;
    }
    return out;
  }

  /** A write. A transport failure throws TransportError for the caller to settle. */
  async write(method: string, p: string, body?: unknown): Promise<Reply> {
    return this.raw(method, p, await this.token(), body);
  }
}

/** Open a file a slot wrote: regular file only, no symlink, bounded. */
/**
 * O_NOFOLLOW covers only the last component. A link a slot planted higher up the path is
 * refused too; the system's own root-owned links (/tmp, /var) are not a slot's doing.
 */
function refusePlantedLinks(file: string): void {
  let cur: string = path.sep;
  for (const part of path.resolve(file).split(path.sep).filter(Boolean).slice(0, -1)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      throw new Refused("handoff_unreadable", `${file}: ${(err as Error).message}`);
    }
    if (st.isSymbolicLink() && st.uid !== 0) throw new Refused("handoff_unreadable", `${file}: ${cur} is a symbolic link`);
  }
}

function readUntrusted(file: string, limit: number): Buffer {
  refusePlantedLinks(file);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    throw new Refused("handoff_unreadable", `${file}: ${(err as Error).message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Refused("handoff_unreadable", `${file}: not a regular file`);
    if (st.size > limit) throw new Refused("handoff_too_large", `${file}: ${st.size} bytes`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export type Manifest = {
  task_id: string;
  attempt_id: string;
  repo: string;
  base_sha: string;
  head_sha: string;
  branch: string;
  changed_files: string[];
  sha256: string;
};

export function parseManifest(raw: Buffer): Manifest {
  let m: any;
  try {
    m = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Refused("bad_manifest", "not JSON");
  }
  const bad = (what: string): never => {
    throw new Refused("bad_manifest", what);
  };
  if (typeof m?.task_id !== "string" || !TASK.test(m.task_id)) bad("task_id");
  if (typeof m.attempt_id !== "string" || !TASK.test(m.attempt_id)) bad("attempt_id");
  if (typeof m.repo !== "string") bad("repo");
  if (typeof m.base_sha !== "string" || !SHA.test(m.base_sha)) bad("base_sha");
  if (typeof m.head_sha !== "string" || !SHA.test(m.head_sha)) bad("head_sha");
  if (typeof m.branch !== "string" || !BRANCH.test(m.branch) || m.branch.includes("..") || m.branch.includes("//") || /(\.lock|\/|\.)$/.test(m.branch)) bad("branch");
  if (!Array.isArray(m.changed_files) || m.changed_files.length === 0 || m.changed_files.some((f: unknown) => typeof f !== "string")) bad("changed_files");
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) bad("sha256");
  return m as Manifest;
}

/** A path is allowed by an exact entry or by a directory entry ending in a slash. */
export function allowed(file: string, allow: string[]): boolean {
  return allow.some((a) => (a.endsWith("/") ? file.startsWith(a) : file === a));
}

type Raw = { path: string; newMode: string; oldMode: string };

/** `git diff --raw -z --no-renames` into one entry per path. */
export function parseRaw(out: string): Raw[] {
  const parts = out.split("\0").filter((p) => p !== "");
  if (parts.length % 2 !== 0) throw new Unreadable("git diff --raw: odd output");
  const res: Raw[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const f = parts[i]!.split(" ");
    if (f.length < 5 || !f[0]!.startsWith(":")) throw new Unreadable("git diff --raw: malformed entry");
    res.push({ path: parts[i + 1]!, oldMode: f[0]!.slice(1), newMode: f[1]! });
  }
  return res;
}

class Git {
  private readonly cwd: string;
  private readonly env: Record<string, string>;

  constructor(cwd: string, scratch: string, token: string) {
    this.cwd = cwd;
    const ask = path.join(scratch, "askpass");
    fs.writeFileSync(ask, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token;; *) printf %s "$MCTL_PUBLISH_TOKEN";; esac\n', { mode: 0o700 });
    this.env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: scratch,
      GIT_ASKPASS: ask,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      MCTL_PUBLISH_TOKEN: token,
    };
  }

  run(...args: string[]): { code: number; out: string; err: string } {
    const r = spawnSync("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "transfer.fsckObjects=true", ...args], {
      cwd: this.cwd,
      env: this.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    return { code: r.status ?? -1, out: r.stdout ?? "", err: redact(r.stderr ?? "") };
  }

  must(...args: string[]): string {
    const r = this.run(...args);
    if (r.code !== 0) throw new Unreadable(`git ${args[0]}: ${r.err.trim().slice(0, 400)}`);
    return r.out;
  }
}

/**
 * updateFrom: the head the branch is expected to be at now. Set, publish adds the handoff's
 * commits to an existing PR instead of opening one: the branch must be exactly there (compare
 * and swap), the new head must descend from it (a fast-forward, never a rewrite), and the open
 * PR on the branch must be this App's own. Unset, an occupied branch is refused as before.
 */
export type PublishOpts = { repo: string; bundle: string; manifest: string; allow: string[]; title: string; body: string; updateFrom?: string };

function checkRepo(cfg: Config, repo: string): void {
  if (!cfg.repos.includes(repo)) throw new Refused("repo_not_allowed", repo);
}

function ledgerFile(cfg: Config, m: Manifest): string {
  const key = crypto.createHash("sha256").update(`${m.repo}\0${m.task_id}\0${m.head_sha}`).digest("hex");
  return path.join(cfg.home, "publish", "ledger", `${key}.json`);
}

export async function publish(cfg: Config, gh: GitHub, o: PublishOpts): Promise<Record<string, unknown>> {
  checkRepo(cfg, o.repo);
  const root = path.join(cfg.home, "publish");
  fs.mkdirSync(path.join(root, "ledger"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "staging"), { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const staging = fs.mkdtempSync(path.join(root, "staging", "s-"));
  try {
    // Copy first. Everything below reads the copy, which the slot can no longer change.
    const manifestRaw = readUntrusted(o.manifest, MAX_MANIFEST_BYTES);
    const bundleRaw = readUntrusted(o.bundle, MAX_BUNDLE_BYTES);
    const bundle = path.join(staging, "h.bundle");
    fs.writeFileSync(bundle, bundleRaw, { mode: 0o600 });
    const m = parseManifest(manifestRaw);
    if (m.repo !== o.repo) throw new Refused("wrong_repo", `the manifest says ${m.repo}`);
    const actual = crypto.createHash("sha256").update(bundleRaw).digest("hex");
    if (actual !== m.sha256) throw new Refused("sha256_mismatch", `the bundle is ${actual}`);

    const ledger = ledgerFile(cfg, m);
    if (fs.existsSync(ledger)) {
      let prior: any;
      try {
        prior = JSON.parse(fs.readFileSync(ledger, "utf8"));
      } catch (err) {
        throw new Unreadable(`ledger: ${(err as Error).message}`);
      }
      if (prior.state === "done") return { ok: true, duplicate: true, pr: prior.pr, url: prior.url, head: m.head_sha, branch: m.branch };
    }

    const cache = path.join(root, "cache", `${o.repo.replace("/", "__")}.git`);
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    const scratch = path.join(staging, "home");
    fs.mkdirSync(scratch, { mode: 0o700 });
    const git = new Git(cache, scratch, await gh.token());
    if (!fs.existsSync(path.join(cache, "HEAD"))) git.must("init", "-q", "--bare");
    const url = `${cfg.gitBase}/${o.repo}.git`;
    git.must("fetch", "-q", "--no-tags", url, "+refs/heads/main:refs/remotes/origin/main");

    if (git.run("cat-file", "-e", `${m.base_sha}^{commit}`).code !== 0) throw new Refused("base_not_on_main", m.base_sha);
    if (git.run("merge-base", "--is-ancestor", m.base_sha, "refs/remotes/origin/main").code !== 0) throw new Refused("base_not_on_main", m.base_sha);
    const verified = git.run("bundle", "verify", bundle);
    if (verified.code !== 0) throw new Refused("bad_bundle", verified.err.trim().slice(0, 400));
    const heads = git.must("bundle", "list-heads", bundle).split("\n").map((l) => l.split(" ")[0]);
    if (!heads.includes(m.head_sha)) throw new Refused("head_not_in_bundle", m.head_sha);
    const pulled = git.run("fetch", "-q", "--no-tags", bundle, `+refs/heads/*:refs/publish/${m.task_id}/*`);
    if (pulled.code !== 0) throw new Refused("bad_bundle", pulled.err.trim().slice(0, 400));
    try {
      if (git.run("cat-file", "-e", `${m.head_sha}^{commit}`).code !== 0) throw new Refused("head_not_in_bundle", m.head_sha);
      if (git.run("merge-base", "--is-ancestor", m.base_sha, m.head_sha).code !== 0) throw new Refused("head_not_on_base", m.head_sha);

      const range = `${m.base_sha}..${m.head_sha}`;
      const merges = git.must("rev-list", "--min-parents=2", range).split("\n").filter(Boolean);
      if (merges.length) throw new Refused("merge_commit", merges[0]!);
      // Workspace rule: no Co-Authored-By trailer on any commit. A slot's harness reminder asks for
      // one, so it is checked here on every commit of the range, not trusted to the slot.
      // Any line counts, not only a parsed trailer block: a line in the body lands in main's history too.
      for (const c of git.must("rev-list", range).split("\n").filter(Boolean)) {
        if (/^\s*co-authored-by\s*:/im.test(git.must("log", "-1", "--format=%B", c))) throw new Refused("co_authored_by", c);
      }
      const raw = parseRaw(git.must("diff", "--raw", "--no-abbrev", "--no-renames", "-z", m.base_sha, m.head_sha));
      if (raw.length === 0) throw new Refused("no_changes", m.head_sha);
      const real = raw.map((r) => r.path).sort();
      const claimed = [...new Set(m.changed_files)].sort();
      if (JSON.stringify(real) !== JSON.stringify(claimed)) throw new Refused("files_mismatch", `the commits change ${real.join(", ")}`);
      // We merge with a merge commit, so every commit lands in main's history: a file added
      // and then reverted is not in the final diff, yet it is published all the same.
      const commits = git.must("rev-list", range).split("\n").filter(Boolean);
      const touched = commits.flatMap((c) => parseRaw(git.must("diff", "--raw", "--no-abbrev", "--no-renames", "-z", `${c}^`, c)));
      const everyPath = [...new Set(touched.map((r) => r.path))].sort();
      const outside = everyPath.filter((f) => !allowed(f, o.allow));
      if (outside.length) throw new Refused("outside_allowed_files", outside.join(", "));
      const workflows = everyPath.filter((f) => f.startsWith(".github/workflows/") || f.startsWith(".github/actions/"));
      if (workflows.length) throw new Refused("workflow_change", `owner gate: ${workflows.join(", ")}`);
      const special = touched.filter((r) => [r.newMode, r.oldMode].some((x) => x === "120000" || x === "160000"));
      if (special.length) throw new Refused("special_file", special.map((r) => r.path).join(", "));

      fs.writeFileSync(ledger, JSON.stringify({ state: "intent", task_id: m.task_id, attempt_id: m.attempt_id, head: m.head_sha, branch: m.branch }), { mode: 0o600 });

      const remote = (): string | null => {
        const r = git.run("ls-remote", url, `refs/heads/${m.branch}`);
        if (r.code !== 0) throw new Unreadable(`git ls-remote: ${r.err.trim().slice(0, 400)}`);
        return r.out.split("\t")[0]?.trim() || null;
      };
      const present = remote();
      if (o.updateFrom !== undefined) return await update(gh, git, url, o, m, present, ledger);
      if (present !== null && present !== m.head_sha) throw new Refused("branch_taken", `${m.branch} is at ${present}`);
      if (present === null) {
        // Never forced: a push that cannot fast-forward is refused by the server.
        const pushed = git.run("push", "-q", url, `${m.head_sha}:refs/heads/${m.branch}`);
        if (pushed.code !== 0 && remote() !== m.head_sha) throw new Refused("push_refused", pushed.err.trim().slice(0, 600));
      }

      const [owner] = o.repo.split("/");
      const open = (await gh.list(`/repos/${o.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(m.branch)}`)).filter((p) => p.head?.sha === m.head_sha);
      let pr = open[0];
      if (!pr) {
        let r: Reply;
        try {
          r = await gh.write("POST", `/repos/${o.repo}/pulls`, { title: o.title, body: o.body, head: m.branch, base: "main", draft: true });
        } catch (err) {
          if (err instanceof TransportError) throw new OutcomeUnknown(`the branch is pushed, the PR is unknown: ${err.message}`);
          throw err;
        }
        if (r.status >= 500) throw new OutcomeUnknown(`the branch is pushed, the PR is unknown: status ${r.status}`);
        if (r.status !== 201) throw new Refused("pr_refused", `status ${r.status}: ${String(r.data?.message)}`);
        pr = r.data;
      }
      fs.writeFileSync(ledger, JSON.stringify({ state: "done", task_id: m.task_id, attempt_id: m.attempt_id, head: m.head_sha, branch: m.branch, pr: pr.number, url: pr.html_url }), { mode: 0o600 });
      return { ok: true, pr: pr.number, url: pr.html_url, head: m.head_sha, branch: m.branch, draft: pr.draft === true };
    } finally {
      // Refs from the bundle must not outlive this run: a later bundle could lean on them.
      for (const line of git.run("for-each-ref", "--format=%(refname)", `refs/publish/${m.task_id}/`).out.split("\n")) {
        if (line) git.run("update-ref", "-d", line);
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** The --update-from half of publish: everything about the commits is already checked. */
async function update(gh: GitHub, git: Git, url: string, o: PublishOpts, m: Manifest, present: string | null, ledger: string): Promise<Record<string, unknown>> {
  const from = o.updateFrom!;
  // `present === m.head_sha` is a run resumed after its push: the checks still run, so the
  // ledger never records an updated_from the new head does not descend from.
  if (present === null) throw new Refused("no_branch", `${m.branch} does not exist: there is nothing to update`);
  if (present !== from && present !== m.head_sha) throw new Refused("branch_moved", `${m.branch} is at ${present}, not ${from}`);
  if (git.run("merge-base", "--is-ancestor", from, m.head_sha).code !== 0) throw new Refused("not_fast_forward", `${m.head_sha} does not descend from ${from}`);
  // The PR is looked up by branch, not by head: before the push its head is the old one.
  const [owner] = o.repo.split("/");
  const open = await gh.list(`/repos/${o.repo}/pulls?state=open&head=${owner}:${encodeURIComponent(m.branch)}`);
  if (open.length === 0) throw new Refused("no_open_pr", `no open PR on ${m.branch}`);
  if (open.length > 1) throw new Refused("ambiguous_pr", `${open.length} open PRs on ${m.branch}`);
  const pr = open[0];
  const slug = (await gh.app())?.slug;
  if (typeof slug !== "string" || slug === "") throw new Unreadable("the App has no slug");
  const author = pr?.user?.login;
  if (typeof author !== "string") throw new Unreadable("the PR has no author");
  // Only the App's own PR: it never pushes onto a branch a person or another bot opened.
  if (author !== `${slug}[bot]` || pr?.user?.type !== "Bot") throw new Refused("not_own_pr", `PR #${pr.number} was opened by ${author}`);
  if (pr?.head?.repo?.full_name !== o.repo) throw new Refused("not_own_pr", `PR #${pr.number} comes from another repository`);
  if (pr?.base?.ref !== "main") throw new Refused("wrong_base", `PR #${pr.number} targets ${String(pr?.base?.ref)}`);
  // The PR listing may lag the branch: after a resumed push it shows either head.
  const prHead = pr?.head?.sha;
  if (prHead !== from && !(present === m.head_sha && prHead === m.head_sha)) throw new Refused("branch_moved", `PR #${pr.number} is at ${String(pr?.head?.sha)}, not ${from}`);
  if (present !== m.head_sha) {
    // A plain push: the server takes only a fast-forward, so a branch moved since the read above fails it.
    const pushed = git.run("push", "-q", url, `${m.head_sha}:refs/heads/${m.branch}`);
    if (pushed.code !== 0) {
      let now: string | null;
      try {
        const r = git.run("ls-remote", url, `refs/heads/${m.branch}`);
        if (r.code !== 0) throw new Error(r.err);
        now = r.out.split("\t")[0]?.trim() || null;
      } catch (err) {
        throw new OutcomeUnknown(`the push failed and the branch could not be read back: ${(err as Error).message}`);
      }
      if (now !== m.head_sha) throw new Refused("push_refused", pushed.err.trim().slice(0, 600));
    }
  }
  fs.writeFileSync(ledger, JSON.stringify({ state: "done", task_id: m.task_id, attempt_id: m.attempt_id, head: m.head_sha, branch: m.branch, pr: pr.number, url: pr.html_url, updated_from: from }), { mode: 0o600 });
  return { ok: true, pr: pr.number, url: pr.html_url, head: m.head_sha, branch: m.branch, updated_from: from, draft: pr.draft === true };
}

async function readPr(gh: GitHub, repo: string, pr: number, head: string): Promise<any> {
  const p = await gh.read(`/repos/${repo}/pulls/${pr}`);
  if (typeof p?.head?.sha !== "string") throw new Unreadable("the PR has no head");
  if (p.head.sha !== head) throw new Refused("head_moved", `the head is ${p.head.sha}`);
  return p;
}

export async function ready(cfg: Config, gh: GitHub, repo: string, pr: number, head: string): Promise<Record<string, unknown>> {
  checkRepo(cfg, repo);
  const p = await readPr(gh, repo, pr, head);
  if (p.state !== "open") throw new Refused("not_open", String(p.state));
  if (p.draft !== true) return { ok: true, pr, head, already: true };
  let r: Reply;
  try {
    r = await gh.write("POST", "/graphql", {
      query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
      variables: { id: p.node_id },
    });
  } catch (err) {
    if (err instanceof TransportError) throw new OutcomeUnknown(err.message);
    throw err;
  }
  if (r.status >= 500) throw new OutcomeUnknown(`ready: status ${r.status}`);
  if (r.status !== 200 || r.data?.errors) throw new Refused("ready_refused", JSON.stringify(r.data?.errors ?? r.status).slice(0, 400));
  return { ok: true, pr, head };
}

/**
 * Brings the App's own PR up to date with main on GitHub's side, by merging main into the
 * branch, so that a repository requiring an up-to-date branch can merge it. Pinned to the head
 * (GitHub refuses if the branch has moved), and only for a PR the App opened itself. The new
 * head is a different commit: it needs its own review and checks before `merge` takes it.
 */
export async function updateBranch(cfg: Config, gh: GitHub, repo: string, pr: number, head: string): Promise<Record<string, unknown>> {
  checkRepo(cfg, repo);
  const p = await readPr(gh, repo, pr, head);
  if (p.state !== "open" || p.merged === true) throw new Refused("not_open", String(p.state));
  if (p.base?.ref !== "main") throw new Refused("wrong_base", String(p.base?.ref));
  const slug = (await gh.app())?.slug;
  if (!slug || typeof slug !== "string") throw new Unreadable("the App has no slug");
  const author = p?.user?.login;
  if (!author || typeof author !== "string") throw new Unreadable("the PR has no author");
  if (author !== `${slug}[bot]` || p?.user?.type !== "Bot") throw new Refused("not_own_pr", `PR #${pr} was opened by ${author}`);
  if (p?.head?.repo?.full_name !== repo) throw new Refused("not_own_pr", `PR #${pr} comes from another repository`);
  // Whether it is behind is read, not inferred from mergeable_state, which reports "blocked"
  // ahead of "behind" and null while GitHub is still computing.
  const cmp = await gh.read(`/repos/${repo}/compare/main...${head}`);
  if (typeof cmp?.behind_by !== "number") throw new Unreadable("compare returned no behind_by");
  if (cmp.behind_by === 0) return { ok: true, pr, head, already: true };
  let r: Reply;
  try {
    r = await gh.write("PUT", `/repos/${repo}/pulls/${pr}/update-branch`, { expected_head_sha: head });
  } catch (err) {
    if (err instanceof TransportError) throw new OutcomeUnknown(err.message);
    throw err;
  }
  if (r.status >= 500) throw new OutcomeUnknown(`update-branch: status ${r.status}`);
  if (r.status !== 202) throw new Refused("update_refused", `status ${r.status}: ${String(r.data?.message)}`);
  return { ok: true, pr, from: head, behind_by: cmp.behind_by, accepted: true, next: "GitHub merges main into the branch in the background: read the PR's new head, then wait for its review and checks on that head" };
}

/**
 * The checks the repository itself demands of main. They live in two separate places: a
 * ruleset (`/rules/branches/main`) or classic protection (`/branches/main`), and a repository
 * may use either. A shape this code does not recognise is a failed read, never "no checks".
 */
export async function requiredChecks(gh: GitHub, repo: string): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (context: unknown) => {
    if (typeof context !== "string" || context === "") throw new Unreadable("a required check has no name");
    out.add(context);
  };
  for (const rule of await gh.list(`/repos/${repo}/rules/branches/main`)) {
    if (rule?.type !== "required_status_checks") continue;
    const list = rule?.parameters?.required_status_checks;
    if (!Array.isArray(list)) throw new Unreadable("a required_status_checks rule has no list");
    for (const c of list) add(c?.context);
  }
  const branch = await gh.read(`/repos/${repo}/branches/main`);
  if (branch?.protected === false) return out;
  if (branch?.protected !== true) throw new Unreadable("the branch does not say whether it is protected");
  // A ruleset alone also reads as protected, with classic protection disabled or enforcing nothing.
  const enabled = branch?.protection?.enabled;
  if (enabled === false) return out;
  if (enabled !== true) throw new Unreadable("the branch does not say whether protection is enabled");
  const classic = branch?.protection?.required_status_checks;
  if (typeof classic?.enforcement_level !== "string") throw new Unreadable("classic protection has no enforcement level");
  if (classic.enforcement_level === "off") return out;
  if (!Array.isArray(classic.contexts)) throw new Unreadable("classic protection has no list of checks");
  for (const c of classic.contexts) add(c);
  return out;
}

/**
 * Drops a cancelled run that a newer run of the same check replaced: a new push or a repeated
 * trigger cancels the run in progress, and that says nothing about the head. Only a cancelled
 * run goes. A failure stays a failure even under a newer success, because two workflows may
 * give their jobs one name, and the newer run is then checked like any other.
 */
export function withoutSuperseded(runs: any[]): any[] {
  const key = (c: any) => `${String(c?.app?.id)}/${String(c?.name)}`;
  const newest = new Map<string, number>();
  for (const c of runs) {
    if (typeof c?.id !== "number") throw new Unreadable("a check run has no id");
    newest.set(key(c), Math.max(newest.get(key(c)) ?? 0, c.id));
  }
  return runs.filter((c) => !(c.conclusion === "cancelled" && c.id < newest.get(key(c))!));
}

/** Everything `merge` demands of the current head. Throws on the first thing that fails. */
export async function gate(gh: GitHub, repo: string, pr: number, head: string): Promise<void> {
  const p = await readPr(gh, repo, pr, head);
  if (p.state !== "open" || p.merged === true) throw new Refused("not_open", String(p.state));
  if (p.draft === true) throw new Refused("draft", `PR ${pr} is a draft`);
  if (p.base?.ref !== "main") throw new Refused("wrong_base", String(p.base?.ref));

  const reviews = await gh.list(`/repos/${repo}/pulls/${pr}/reviews`);
  const latest = new Map<string, any>();
  for (const r of reviews) {
    if (r?.state === "COMMENTED" || r?.state === "PENDING") continue;
    if (typeof r?.user?.login !== "string") throw new Unreadable("a review has no author");
    latest.set(r.user.login, r);
  }
  for (const [who, r] of latest) if (r.state === "CHANGES_REQUESTED") throw new Refused("changes_requested", who);
  const claude = latest.get(REVIEW_BOT);
  if (!claude || claude.state !== "APPROVED" || claude.commit_id !== head) throw new Refused("not_approved", `${REVIEW_BOT} has not approved ${head}`);

  const runs = withoutSuperseded(await gh.list(`/repos/${repo}/commits/${head}/check-runs`, "check_runs"));
  for (const c of runs) {
    if (c?.status !== "completed") throw new Refused("checks_pending", String(c?.name));
    if (!PASSING.has(c?.conclusion)) throw new Refused("checks_failed", `${c?.name}: ${c?.conclusion}`);
  }
  const combined = await gh.read(`/repos/${repo}/commits/${head}/status?per_page=100`);
  if (!Array.isArray(combined?.statuses)) throw new Unreadable("commit statuses are not a list");
  if (combined.statuses.length !== combined.total_count) throw new Unreadable(`read ${combined.statuses.length} commit statuses of ${String(combined.total_count)}`);
  for (const s of combined.statuses) if (s?.state !== "success") throw new Refused("checks_failed", `${s?.context}: ${s?.state}`);
  // Every run and status left has passed by now, so a required check only has to be among them.
  // No required check at all would let a head with no CI through on an empty list.
  const required = await requiredChecks(gh, repo);
  if (required.size === 0) throw new Refused("no_required_checks", `${repo} requires no check on main`);
  const seen = new Set<string>([...runs.map((c) => c.name), ...combined.statuses.map((s: any) => s.context)]);
  for (const name of required) if (!seen.has(name)) throw new Refused("checks_pending", `${name} has not passed on this head`);

  // Read again, last: the first read only starts GitHub's lazy computation, and null means
  // "not yet", never "fine". This read also sees a head that moved during the checks above.
  const last = await readPr(gh, repo, pr, head);
  if (last.mergeable !== true || last.mergeable_state !== "clean") throw new Refused("not_mergeable", `${String(last.mergeable)} ${String(last.mergeable_state)}`);
}

export async function merge(cfg: Config, gh: GitHub, repo: string, pr: number, head: string): Promise<Record<string, unknown>> {
  checkRepo(cfg, repo);
  await gate(gh, repo, pr, head);
  let r: Reply;
  try {
    r = await gh.write("PUT", `/repos/${repo}/pulls/${pr}/merge`, { merge_method: "merge", sha: head });
  } catch (err) {
    if (err instanceof TransportError) throw new OutcomeUnknown(err.message);
    throw err;
  }
  if (r.status === 200 && r.data?.merged === true) return { ok: true, pr, head, merge_commit: r.data.sha };
  if (r.status >= 500) throw new OutcomeUnknown(`merge: status ${r.status}`);
  throw new Refused("merge_refused", `status ${r.status}: ${String(r.data?.message)}`);
}

export async function status(cfg: Config, gh: GitHub): Promise<Record<string, unknown>> {
  const app = await gh.app();
  const repos = await gh.list("/installation/repositories", "repositories");
  return { ok: true, app: app?.slug, permissions: app?.permissions, installed: repos.map((r) => r.full_name), allowed: cfg.repos };
}

function args(argv: string[], valued: string[], repeated: string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!valued.includes(a) && !repeated.includes(a)) throw new UsageError(`unknown argument ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value`);
    if (repeated.includes(a)) ((out[a] ??= []) as string[]).push(v);
    else out[a] = v;
  }
  return out;
}

function need(a: Record<string, string | string[]>, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || v === "") throw new UsageError(`${k} is required`);
  return v;
}

function prArgs(argv: string[]): { repo: string; pr: number; head: string } {
  const a = args(argv, ["--repo", "--pr", "--head"]);
  const pr = Number(need(a, "--pr"));
  const head = need(a, "--head");
  if (!Number.isInteger(pr) || pr <= 0) throw new UsageError("--pr must be a number");
  if (!SHA.test(head)) throw new UsageError("--head must be a full SHA");
  return { repo: need(a, "--repo"), pr, head };
}

const USAGE = `usage: mctl-publish status
       mctl-publish publish --repo R --bundle F --manifest F --allow PATH [--allow PATH ...] --title T --body-file F [--update-from SHA]
       mctl-publish ready --repo R --pr N --head SHA
       mctl-publish merge --repo R --pr N --head SHA
       mctl-publish update-branch --repo R --pr N --head SHA
Exit: 0 ok, 1 usage, 2 unreadable, 3 refused, 4 outcome unknown.`;

export async function main(argv: string[], cfg: Config = config()): Promise<number> {
  const print = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v)}\n`);
  const gh = new GitHub(cfg);
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "status":
        args(rest, []);
        print(await status(cfg, gh));
        return 0;
      case "publish": {
        const a = args(rest, ["--repo", "--bundle", "--manifest", "--title", "--body-file", "--update-from"], ["--allow"]);
        const allow = (a["--allow"] as string[] | undefined) ?? [];
        if (allow.length === 0) throw new UsageError("--allow is required");
        const updateFrom = a["--update-from"] as string | undefined;
        if (updateFrom !== undefined && !SHA.test(updateFrom)) throw new UsageError("--update-from must be a full SHA");
        print(await publish(cfg, gh, {
          repo: need(a, "--repo"),
          bundle: need(a, "--bundle"),
          manifest: need(a, "--manifest"),
          allow,
          title: need(a, "--title"),
          body: readUntrusted(need(a, "--body-file"), MAX_BODY_BYTES).toString("utf8"),
          updateFrom,
        }));
        return 0;
      }
      case "ready": {
        const p = prArgs(rest);
        print(await ready(cfg, gh, p.repo, p.pr, p.head));
        return 0;
      }
      case "merge": {
        const p = prArgs(rest);
        print(await merge(cfg, gh, p.repo, p.pr, p.head));
        return 0;
      }
      case "update-branch": {
        const p = prArgs(rest);
        print(await updateBranch(cfg, gh, p.repo, p.pr, p.head));
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
