import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GitHub, OutcomeUnknown, Refused, Unreadable, allowed, config, main, merge, parseManifest, parseRaw, publish, ready } from "../src/publish.ts";
import type { Config, Manifest } from "../src/publish.ts";

const REPO = "mctlhq/r";
const TOKEN = "ghs_faketokenfaketokenfaketoken123456";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };
function git(cwd: string, ...a: string[]): string {
  const r = spawnSync("git", a, { cwd, env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Fake = {
  calls: { method: string; path: string; body: any }[];
  pulls: any[];
  pr: any;
  reviews: any[];
  runs: any[];
  statuses: any[];
  fail: Record<string, number>;
  dropMerge: boolean;
  dropPull: boolean;
  mergeReply: { status: number; body: any };
  tokenSeen: string[];
};

let server: ReturnType<typeof Bun.serve>;
let fake: Fake;
const J = (d: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", ...headers } });

function handle(req: Request, url: URL, body: any): Response {
  const p = url.pathname;
  const key = `${req.method} ${p}`;
  const auth = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  if (fake.fail[key] !== undefined) return J({ message: "fail" }, fake.fail[key]);
  if (key === "POST /app/installations/9/access_tokens") {
    const [h, c, s] = auth.split(".");
    if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, "base64url"))) return J({}, 401);
    return J({ token: TOKEN }, 201);
  }
  if (key === "DELETE /installation/token") return new Response(null, { status: 204 });
  fake.tokenSeen.push(auth);
  if (key === "GET /installation/repositories") return J({ total_count: 1, repositories: [{ full_name: REPO }] });
  if (key === "GET /repos/mctlhq/r/pulls") return J(fake.pulls);
  if (key === "POST /repos/mctlhq/r/pulls") {
    if (fake.dropPull) throw new Error("drop");
    const pr = { number: 7, html_url: "https://x/7", draft: body.draft, head: { sha: "unused" } };
    return J(pr, 201);
  }
  if (key === "GET /repos/mctlhq/r/pulls/7") return J(fake.pr);
  if (key === "GET /repos/mctlhq/r/pulls/7/reviews") return J(fake.reviews);
  if (key === "PUT /repos/mctlhq/r/pulls/7/merge") {
    if (fake.dropMerge) throw new Error("drop");
    return J(fake.mergeReply.body, fake.mergeReply.status);
  }
  if (key === "POST /graphql") return J({ data: {} });
  if (p.endsWith("/check-runs")) return J({ total_count: fake.runs.length, check_runs: fake.runs });
  if (p.endsWith("/status")) return J({ statuses: fake.statuses });
  return J({ message: "no route " + key }, 404);
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const body = text ? JSON.parse(text) : null;
      fake.calls.push({ method: req.method, path: url.pathname, body });
      return handle(req, url, body);
    },
    error: () => new Response("not json", { status: 502 }),
  });
});
afterAll(() => void server.stop(true));

let tmp: string;
let cfg: Config;
let gh: GitHub;
let base: string;
let remote: string;
let work: string;
const HEAD = "a".repeat(40);

beforeEach(() => {
  fake = {
    calls: [], pulls: [], tokenSeen: [], fail: {}, dropMerge: false, dropPull: false,
    pr: { state: "open", draft: false, node_id: "N1", head: { sha: HEAD }, base: { ref: "main" }, mergeable: true, mergeable_state: "clean" },
    reviews: [{ user: { login: "claude[bot]" }, state: "APPROVED", commit_id: HEAD }],
    runs: [{ name: "validate", status: "completed", conclusion: "success" }, { name: "docker", status: "completed", conclusion: "skipped" }],
    statuses: [],
    mergeReply: { status: 200, body: { merged: true, sha: "m".repeat(40) } },
  };
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publish-")));
  fs.writeFileSync(path.join(tmp, "key.pem"), PEM, { mode: 0o600 });
  const gitBase = path.join(tmp, "remote");
  remote = path.join(gitBase, `${REPO}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  work = path.join(tmp, "work");
  fs.mkdirSync(work);
  git(work, "init", "-q");
  git(work, "checkout", "-q", "-b", "main");
  fs.mkdirSync(path.join(work, "src"));
  fs.writeFileSync(path.join(work, "src/a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-q", remote, "main");
  base = git(work, "rev-parse", "HEAD");
  cfg = {
    home: path.join(tmp, "home"), appId: "1", installationId: "9", keyFile: path.join(tmp, "key.pem"), repos: [REPO],
    apiUrl: `http://127.0.0.1:${server.port}`, gitBase, timeoutMs: 5000,
  };
  fs.mkdirSync(cfg.home);
  gh = new GitHub(cfg);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** What a slot produces: one commit on a branch, a bundle and a manifest. */
function handoff(edit: (dir: string) => void = (d) => fs.writeFileSync(path.join(d, "src/a.txt"), "b\n"), over: Partial<Manifest> = {}): { bundle: string; manifest: string; m: Manifest } {
  git(work, "checkout", "-q", "-B", "feat/x", base);
  edit(work);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "feat: x");
  const head = git(work, "rev-parse", "HEAD");
  const files = git(work, "diff", "--name-only", base, head).split("\n");
  const bundle = path.join(tmp, "h.bundle");
  git(work, "bundle", "create", "-q", bundle, "feat/x", `^${base}`);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
  const m: Manifest = { task_id: "t-1", attempt_id: "a-1", repo: REPO, base_sha: base, head_sha: head, branch: "feat/x", changed_files: files, sha256, ...over };
  const manifest = path.join(tmp, "h.json");
  fs.writeFileSync(manifest, JSON.stringify(m));
  return { bundle, manifest, m };
}
const opts = (h: { bundle: string; manifest: string }, allow = ["src/"]) => ({ repo: REPO, bundle: h.bundle, manifest: h.manifest, allow, title: "feat: x", body: "b" });
async function refused(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(Refused);
  expect(err.code).toBe(code);
}
const remoteRefs = (): string => git(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
const writes = (): string[] => fake.calls.filter((c) => c.method !== "GET" && !c.path.includes("access_tokens") && c.path !== "/installation/token").map((c) => `${c.method} ${c.path}`);

describe("publish", () => {
  test("pushes the same commit, opens a Draft PR, and is idempotent", async () => {
    const h = handoff();
    const r = await publish(cfg, gh, opts(h));
    expect(r).toMatchObject({ ok: true, pr: 7, head: h.m.head_sha, branch: "feat/x", draft: true });
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${h.m.head_sha}`);
    expect(fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!.body).toMatchObject({ draft: true, base: "main", head: "feat/x" });
    const again = await publish(cfg, gh, opts(h));
    expect(again).toMatchObject({ ok: true, duplicate: true, pr: 7 });
    expect(writes().filter((w) => w.endsWith("/pulls")).length).toBe(1);
  });

  test("a lost PR reply is resumed from the ledger's intent, on an existing open PR", async () => {
    const h = handoff();
    fake.dropPull = true;
    const err = await publish(cfg, gh, opts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(OutcomeUnknown);
    fake.dropPull = false;
    fake.pulls = [{ number: 7, html_url: "https://x/7", draft: true, head: { sha: h.m.head_sha } }];
    const before = writes().length;
    expect(await publish(cfg, gh, opts(h))).toMatchObject({ ok: true, pr: 7 });
    expect(writes().length).toBe(before);
  });

  test("never hands git the keychain helper, and never puts the token in argv", async () => {
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const log = path.join(tmp, "argv.log");
    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$*" >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
    const h = handoff();
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      await publish(cfg, gh, opts(h));
    } finally {
      process.env.PATH = saved;
    }
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) {
      expect(l).toStartWith("-c credential.helper= ");
      expect(l).not.toContain(TOKEN);
    }
    expect(lines.some((l) => l.includes(" push ") && l.includes(" --force"))).toBe(false);
  });

  test("the bundle must match the manifest's hash", async () => {
    const h = handoff(undefined, { sha256: "0".repeat(64) });
    await refused(publish(cfg, gh, opts(h)), "sha256_mismatch");
    expect(remoteRefs()).not.toContain("feat/x");
  });

  test("a symlink is not followed, whichever file it stands in for", async () => {
    const h = handoff();
    const link = path.join(tmp, "link");
    fs.symlinkSync(h.manifest, link);
    await refused(publish(cfg, gh, { ...opts(h), manifest: link }), "handoff_unreadable");
    const blink = path.join(tmp, "blink");
    fs.symlinkSync(h.bundle, blink);
    await refused(publish(cfg, gh, { ...opts(h), bundle: blink }), "handoff_unreadable");
  });

  test("the manifest's repository, file list and base are checked against the commits", async () => {
    await refused(publish(cfg, gh, opts(handoff(undefined, { repo: "mctlhq/other" }))), "wrong_repo");
    await refused(publish(cfg, gh, opts(handoff(undefined, { changed_files: ["src/other.txt"] }))), "files_mismatch");
    await refused(publish(cfg, gh, opts(handoff(undefined, { base_sha: "b".repeat(40) }))), "base_not_on_main");
    await refused(publish(cfg, gh, opts(handoff(undefined, { head_sha: "c".repeat(40) }))), "head_not_in_bundle");
    expect(remoteRefs()).not.toContain("feat/x");
  });

  test("a base known from an earlier handoff but not on main is refused", async () => {
    const first = handoff();
    await publish(cfg, gh, opts(first));
    git(work, "checkout", "-q", "-B", "feat/y", first.m.head_sha);
    fs.writeFileSync(path.join(work, "src/a.txt"), "c\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "feat: y");
    const head = git(work, "rev-parse", "HEAD");
    const bundle = path.join(tmp, "y.bundle");
    git(work, "bundle", "create", "-q", bundle, "feat/y", `^${first.m.head_sha}`);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
    const manifest = path.join(tmp, "y.json");
    fs.writeFileSync(manifest, JSON.stringify({ ...first.m, task_id: "t-2", base_sha: first.m.head_sha, head_sha: head, branch: "feat/y", changed_files: ["src/a.txt"], sha256 }));
    await refused(publish(cfg, gh, opts({ bundle, manifest })), "base_not_on_main");
    expect(remoteRefs()).not.toContain("feat/y");
  });

  test("a change outside the allowed files is refused", async () => {
    const h = handoff((d) => fs.writeFileSync(path.join(d, "secret.txt"), "x\n"));
    await refused(publish(cfg, gh, opts(h, ["src/"])), "outside_allowed_files");
  });

  test("a workflow change is the owner's gate, even when allowed", async () => {
    const h = handoff((d) => {
      fs.mkdirSync(path.join(d, ".github/workflows"), { recursive: true });
      fs.writeFileSync(path.join(d, ".github/workflows/x.yml"), "on: push\n");
    });
    await refused(publish(cfg, gh, opts(h, [".github/"])), "workflow_change");
  });

  test("a symlink in the commits is refused", async () => {
    const h = handoff((d) => fs.symlinkSync("/etc/passwd", path.join(d, "src/l")));
    await refused(publish(cfg, gh, opts(h)), "special_file");
  });

  test("an existing branch elsewhere is not overwritten", async () => {
    git(work, "push", "-q", remote, `${base}:refs/heads/feat/x`);
    const h = handoff();
    await refused(publish(cfg, gh, opts(h)), "branch_taken");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${base}`);
  });

  test("a repository off the list is refused before anything is read", async () => {
    const h = handoff();
    await refused(publish(cfg, gh, { ...opts(h), repo: "mctlhq/api" }), "repo_not_allowed");
    expect(fake.calls.length).toBe(0);
  });

  test("no refs from a bundle stay behind", async () => {
    const h = handoff();
    await publish(cfg, gh, opts(h));
    const cache = path.join(cfg.home, "publish/cache/mctlhq__r.git");
    expect(git(cache, "for-each-ref", "refs/publish/")).toBe("");
    expect(fs.readdirSync(path.join(cfg.home, "publish/staging"))).toEqual([]);
    expect(fs.statSync(path.join(cfg.home, "publish")).mode & 0o077).toBe(0);
  });
});

test("parseManifest refuses unsafe names", () => {
  const good = { task_id: "t", attempt_id: "a", repo: REPO, base_sha: "a".repeat(40), head_sha: "b".repeat(40), branch: "feat/x", changed_files: ["a"], sha256: "c".repeat(64) };
  expect(parseManifest(Buffer.from(JSON.stringify(good))).branch).toBe("feat/x");
  for (const over of [{ branch: "main" }, { branch: "feat/../main" }, { branch: "feat/x.lock" }, { branch: "refs/heads/main" }, { branch: "feat//x" }, { task_id: "../x" }, { attempt_id: "a b" }, { head_sha: "abc" }, { changed_files: [] }, { sha256: "x" }]) {
    expect(() => parseManifest(Buffer.from(JSON.stringify({ ...good, ...over }))), JSON.stringify(over)).toThrow(Refused);
  }
  expect(() => parseManifest(Buffer.from("nope"))).toThrow(Refused);
});

test("allowed and parseRaw", () => {
  expect(allowed("src/a", ["src/"])).toBe(true);
  expect(allowed("srcx/a", ["src/"])).toBe(false);
  expect(allowed("a", ["a"])).toBe(true);
  expect(allowed("a/b", ["a"])).toBe(false);
  expect(parseRaw(":100644 120000 aa bb T\0p\0")).toEqual([{ path: "p", oldMode: "100644", newMode: "120000" }]);
  expect(() => parseRaw(":100644\0")).toThrow(Unreadable);
  expect(() => parseRaw("junk here\0p\0")).toThrow(Unreadable);
});

describe("merge", () => {
  const go = () => merge(cfg, gh, REPO, 7, HEAD);
  const merged = () => writes().filter((w) => w.endsWith("/merge")).length;

  test("merges a green, approved head with a merge commit pinned to the SHA", async () => {
    expect(await go()).toMatchObject({ ok: true, merge_commit: "m".repeat(40) });
    expect(fake.calls.find((c) => c.path.endsWith("/merge"))!.body).toEqual({ merge_method: "merge", sha: HEAD });
  });

  const cases: [string, string, () => void][] = [
    ["a moved head", "head_moved", () => { fake.pr.head.sha = "b".repeat(40); }],
    ["a draft", "draft", () => { fake.pr.draft = true; }],
    ["a closed PR", "not_open", () => { fake.pr.state = "closed"; }],
    ["another base", "wrong_base", () => { fake.pr.base.ref = "dev"; }],
    ["no review", "not_approved", () => { fake.reviews = []; }],
    ["an approval of an earlier head", "not_approved", () => { fake.reviews[0].commit_id = "b".repeat(40); }],
    ["an approval by anyone else", "not_approved", () => { fake.reviews = [{ user: { login: "mctl-codex[bot]" }, state: "APPROVED", commit_id: HEAD }]; }],
    ["a later change request by Claude", "changes_requested", () => { fake.reviews.push({ user: { login: "claude[bot]" }, state: "CHANGES_REQUESTED", commit_id: HEAD }); }],
    ["a change request by anyone", "changes_requested", () => { fake.reviews.push({ user: { login: "mashkovd" }, state: "CHANGES_REQUESTED", commit_id: HEAD }); }],
    ["a running check", "checks_pending", () => { fake.runs.push({ name: "x", status: "in_progress", conclusion: null }); }],
    ["a failed check", "checks_failed", () => { fake.runs.push({ name: "x", status: "completed", conclusion: "failure" }); }],
    ["a failed status", "checks_failed", () => { fake.statuses.push({ context: "x", state: "failure" }); }],
    ["a pending status", "checks_failed", () => { fake.statuses.push({ context: "x", state: "pending" }); }],
    ["no validate at all", "checks_pending", () => { fake.runs = [{ name: "docker", status: "completed", conclusion: "success" }]; }],
    ["mergeability not computed", "not_mergeable", () => { fake.pr.mergeable = null; }],
    ["a blocked state", "not_mergeable", () => { fake.pr.mergeable_state = "blocked"; }],
  ];
  for (const [name, code, set] of cases) {
    test(`refuses ${name}`, async () => {
      set();
      await refused(go(), code);
      expect(merged()).toBe(0);
    });
  }

  test("a commented review does not cancel an approval", async () => {
    fake.reviews.push({ user: { login: "claude[bot]" }, state: "COMMENTED", commit_id: HEAD });
    expect(await go()).toMatchObject({ ok: true });
  });

  for (const route of ["GET /repos/mctlhq/r/pulls/7", "GET /repos/mctlhq/r/pulls/7/reviews", `GET /repos/mctlhq/r/commits/${HEAD}/check-runs`, `GET /repos/mctlhq/r/commits/${HEAD}/status`]) {
    test(`a failed read of ${route.split("/").pop()} is unreadable, not green`, async () => {
      fake.fail[route] = 500;
      await expect(go()).rejects.toThrow(Unreadable);
      expect(merged()).toBe(0);
    });
  }

  test("a server refusal is refused, and a lost reply is unknown and not retried", async () => {
    fake.mergeReply = { status: 405, body: { message: "rules" } };
    await refused(go(), "merge_refused");
    fake.dropMerge = true;
    await expect(go()).rejects.toThrow(OutcomeUnknown);
    expect(merged()).toBe(2);
  });

  test("a repository off the list is refused", async () => {
    await refused(merge(cfg, gh, "mctlhq/api", 7, HEAD), "repo_not_allowed");
  });
});

describe("listing", () => {
  test("a total_count that does not add up is a failed read", async () => {
    fake.fail = {};
    const original = fake.runs;
    fake.runs = original;
    const g = new GitHub(cfg);
    const raw = (g as any).raw.bind(g);
    (g as any).raw = async (m: string, u: string, a: string, b: unknown) => {
      const r = await raw(m, u, a, b);
      if (u.includes("check-runs")) r.data.total_count = 99;
      return r;
    };
    await expect(g.list(`/repos/${REPO}/commits/${HEAD}/check-runs`, "check_runs")).rejects.toThrow(Unreadable);
  });

  test("a later page failing is a failed read, and an empty page with a next link too", async () => {
    const g = new GitHub(cfg);
    let n = 0;
    (g as any).token = async () => "t";
    (g as any).raw = async () => (n++ === 0 ? { status: 200, data: [{ a: 1 }], next: "http://x/2" } : { status: 500, data: null, next: null });
    await expect(g.list("/x")).rejects.toThrow(Unreadable);
    (g as any).raw = async () => ({ status: 200, data: [], next: "http://x/2" });
    await expect(g.list("/x")).rejects.toThrow(Unreadable);
  });
});

describe("ready and the CLI", () => {
  test("marks a draft ready, pinned to the head", async () => {
    fake.pr.draft = true;
    expect(await ready(cfg, gh, REPO, 7, HEAD)).toMatchObject({ ok: true });
    expect(fake.calls.find((c) => c.path === "/graphql")!.body.variables.id).toBe("N1");
    fake.pr.head.sha = "b".repeat(40);
    await refused(ready(cfg, gh, REPO, 7, HEAD), "head_moved");
  });

  test("exit codes, and no approve command", async () => {
    const writeOut = process.stdout.write;
    const writeErr = process.stderr.write;
    let out = "";
    (process.stdout as any).write = (s: string) => ((out += s), true);
    (process.stderr as any).write = () => true;
    try {
      expect(await main(["approve", "--repo", REPO, "--pr", "7"], cfg)).toBe(1);
      expect(await main(["merge", "--repo", REPO, "--pr", "7", "--head", "abc"], cfg)).toBe(1);
      expect(await main(["merge", "--repo", REPO, "--pr", "7", "--hed", HEAD], cfg)).toBe(1);
      expect(await main(["merge", "--repo", REPO, "--pr", "7", "--head", HEAD, "--admin", "x"], cfg)).toBe(1);
      expect(await main(["merge", "--repo", "mctlhq/api", "--pr", "7", "--head", HEAD], cfg)).toBe(3);
      fake.fail[`GET /repos/mctlhq/r/pulls/7`] = 500;
      expect(await main(["merge", "--repo", REPO, "--pr", "7", "--head", HEAD], cfg)).toBe(2);
      fake.fail = {};
      fake.dropMerge = true;
      expect(await main(["merge", "--repo", REPO, "--pr", "7", "--head", HEAD], cfg)).toBe(4);
      fake.dropMerge = false;
      expect(await main(["merge", "--repo", REPO, "--pr", "7", "--head", HEAD], cfg)).toBe(0);
    } finally {
      (process.stdout as any).write = writeOut;
      (process.stderr as any).write = writeErr;
    }
    expect(out).toContain('"merge_commit"');
    expect(out).not.toContain(TOKEN);
  });

  test("the token is revoked when the run ends", async () => {
    const writeOut = process.stdout.write;
    (process.stdout as any).write = () => true;
    try {
      await main(["merge", "--repo", REPO, "--pr", "7", "--head", HEAD], cfg);
    } finally {
      (process.stdout as any).write = writeOut;
    }
    expect(fake.calls.some((c) => c.method === "DELETE" && c.path === "/installation/token")).toBe(true);
  });

  test("a missing key is unreadable", async () => {
    const g = new GitHub({ ...cfg, keyFile: path.join(tmp, "absent") });
    await expect(g.token()).rejects.toThrow(Unreadable);
  });

  test("defaults point at the real App and the two installed repositories", () => {
    const c = config({ MCTL_BRIDGE_HOME: "/h" });
    expect(c.keyFile).toBe("/h/etc/codex-github-app.pem");
    expect(c.repos).toEqual(["mctlhq/mctl-claude-remote", "mctlhq/bridge-step0-sandbox"]);
  });
});

test("the source offers no way to approve, force or bypass", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "publish.ts"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const bad of ['"APPROVE"', "--force", '"-f"', "--admin", "/reviews`, {"]) expect(code, bad).not.toContain(bad);
});
