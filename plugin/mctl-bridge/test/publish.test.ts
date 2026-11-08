import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GitHub, OutcomeUnknown, Refused, Unreadable, allowed, config, main, merge, parseManifest, parseRaw, publish, ready, updateBranch } from "../src/publish.ts";
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
  rules: any;
  branch: any;
  statuses: any[];
  statusTotal: number | null;
  prLater: any;
  prReads: number;
  fail: Record<string, number>;
  dropMerge: boolean;
  dropPull: boolean;
  mergeReply: { status: number; body: any };
  behindBy: number | null;
  updateReply: { status: number; body: any };
  dropUpdate: boolean;
  tokenSeen: string[];
  app: any;
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
  if (key === "GET /app") return J(fake.app);
  fake.tokenSeen.push(auth);
  if (key === "GET /installation/repositories") return J({ total_count: 1, repositories: [{ full_name: REPO }] });
  if (key === "GET /repos/mctlhq/r/pulls") return J(fake.pulls);
  if (key === "POST /repos/mctlhq/r/pulls") {
    if (fake.dropPull) throw new Error("drop");
    const pr = { number: 7, html_url: "https://x/7", draft: body.draft, head: { sha: "unused" } };
    return J(pr, 201);
  }
  if (key === "GET /repos/mctlhq/r/pulls/7") return J(++fake.prReads > 1 && fake.prLater ? fake.prLater : fake.pr);
  if (key === "GET /repos/mctlhq/r/pulls/7/reviews") return J(fake.reviews);
  if (key === "PUT /repos/mctlhq/r/pulls/7/merge") {
    if (fake.dropMerge) throw new Error("drop");
    return J(fake.mergeReply.body, fake.mergeReply.status);
  }
  if (key === `GET /repos/mctlhq/r/compare/main...${HEAD}`) return J(fake.behindBy === null ? {} : { behind_by: fake.behindBy, ahead_by: 1 });
  if (key === "PUT /repos/mctlhq/r/pulls/7/update-branch") {
    if (fake.dropUpdate) throw new Error("drop");
    return J(fake.updateReply.body, fake.updateReply.status);
  }
  if (key === "POST /graphql") return J({ data: {} });
  if (key === "GET /repos/mctlhq/r/rules/branches/main") return J(fake.rules);
  if (key === "GET /repos/mctlhq/r/branches/main") return J(fake.branch);
  if (p.endsWith("/check-runs")) return J({ total_count: fake.runs.length, check_runs: fake.runs });
  if (p.endsWith("/status")) return J({ total_count: fake.statusTotal ?? fake.statuses.length, statuses: fake.statuses });
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
    calls: [], pulls: [], tokenSeen: [], app: { slug: "mctl-codex", permissions: { contents: "write" } }, fail: {}, dropMerge: false, dropPull: false,
    pr: { state: "open", draft: false, node_id: "N1", head: { sha: HEAD }, base: { ref: "main" }, mergeable: true, mergeable_state: "clean" },
    reviews: [{ user: { login: "claude[bot]" }, state: "APPROVED", commit_id: HEAD }],
    runs: [{ id: 10, name: "validate", status: "completed", conclusion: "success" }, { id: 11, name: "docker", status: "completed", conclusion: "skipped" }],
    rules: [{ type: "pull_request", parameters: {} }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "validate" }] } }],
    branch: { protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } },
    statuses: [],
    statusTotal: null,
    prLater: null,
    prReads: 0,
    mergeReply: { status: 200, body: { merged: true, sha: "m".repeat(40) } },
    behindBy: 3,
    updateReply: { status: 202, body: { message: "Updating pull request branch." } },
    dropUpdate: false,
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
function commit(file: string, text: string): void {
  fs.writeFileSync(path.join(work, file), text);
  git(work, "add", "-A");
  git(work, "commit", "-qm", `change ${file}`);
}
/** A handoff of whatever the given branch holds on top of `from`. */
function seal(branch: string, from: string, files: string[]): { bundle: string; manifest: string } {
  const bundle = path.join(tmp, "y.bundle");
  git(work, "bundle", "create", "-q", bundle, branch, `^${from}`);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
  const manifest = path.join(tmp, "y.json");
  const m: Manifest = { task_id: "t-2", attempt_id: "a-2", repo: REPO, base_sha: from, head_sha: git(work, "rev-parse", "HEAD"), branch, changed_files: files, sha256 };
  fs.writeFileSync(manifest, JSON.stringify(m));
  return { bundle, manifest };
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
    commit("src/a.txt", "c\n");
    await refused(publish(cfg, gh, opts(seal("feat/y", first.m.head_sha, ["src/a.txt"]))), "base_not_on_main");
    expect(remoteRefs()).not.toContain("feat/y");
  });

  test("a file outside the allow list is refused even when a later commit reverts it", async () => {
    git(work, "checkout", "-q", "-B", "feat/y", base);
    commit("secret.txt", "x\n");
    git(work, "rm", "-q", "secret.txt");
    git(work, "commit", "-qm", "revert");
    commit("src/a.txt", "c\n");
    await refused(publish(cfg, gh, opts(seal("feat/y", base, ["src/a.txt"]))), "outside_allowed_files");
  });

  test("a merge commit in the handoff is refused", async () => {
    git(work, "checkout", "-q", "-B", "side", base);
    commit("src/s.txt", "s\n");
    git(work, "checkout", "-q", "-B", "feat/y", base);
    commit("src/a.txt", "c\n");
    git(work, "merge", "-q", "--no-ff", "-m", "merge", "side");
    await refused(publish(cfg, gh, opts(seal("feat/y", base, ["src/a.txt", "src/s.txt"]))), "merge_commit");
  });

  test("a Co-Authored-By trailer on any commit is refused before anything is pushed", async () => {
    git(work, "checkout", "-q", "-B", "feat/y", base);
    fs.writeFileSync(path.join(work, "src/a.txt"), "c\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "feat: y\n\nAgent: claude\nco-authored-by: Someone <noreply@example.com>");
    commit("src/a.txt", "d\n"); // a clean commit on top does not hide the earlier one
    await refused(publish(cfg, gh, opts(seal("feat/y", base, ["src/a.txt"]))), "co_authored_by");
    expect(remoteRefs()).not.toContain("feat/y");
    expect(writes()).toEqual([]);
  });

  test("a commit that only mentions the trailer mid-line is not refused", async () => {
    git(work, "checkout", "-q", "-B", "feat/y", base);
    fs.writeFileSync(path.join(work, "src/a.txt"), "c\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "fix: refuse the Co-Authored-By: trailer\n\nAgent: claude");
    const r = await publish(cfg, gh, opts(seal("feat/y", base, ["src/a.txt"])));
    expect((r as { ok: boolean }).ok).toBe(true);
  });

  test("a directory link planted above a handoff file is refused", async () => {
    const h = handoff();
    const dir = path.join(tmp, "dlink");
    fs.symlinkSync(tmp, dir);
    await refused(publish(cfg, gh, { ...opts(h), manifest: path.join(dir, "h.json") }), "handoff_unreadable");
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
    ["a running check", "checks_pending", () => { fake.runs.push({ id: 20, name: "x", status: "in_progress", conclusion: null }); }],
    ["a failed check", "checks_failed", () => { fake.runs.push({ id: 20, name: "x", status: "completed", conclusion: "failure" }); }],
    ["a failed status", "checks_failed", () => { fake.statuses.push({ context: "x", state: "failure" }); }],
    ["a pending status", "checks_failed", () => { fake.statuses.push({ context: "x", state: "pending" }); }],
    ["a required check that never ran", "checks_pending", () => { fake.runs = [{ id: 10, name: "docker", status: "completed", conclusion: "success" }]; }],
    ["a repository that requires nothing", "no_required_checks", () => { fake.rules = []; }],
    ["an unprotected branch with no ruleset", "no_required_checks", () => { fake.rules = []; fake.branch = { protected: false }; }],
    ["a required check from classic protection that never ran", "checks_pending", () => {
      fake.rules = [];
      fake.branch.protection.required_status_checks = { enforcement_level: "non_admins", contexts: ["test", "validate"], checks: [] };
    }],
    ["a cancelled run with nothing newer", "checks_failed", () => { fake.runs.push({ id: 20, name: "x", status: "completed", conclusion: "cancelled" }); }],
    ["a cancelled run newer than the success", "checks_failed", () => {
      fake.runs.push({ id: 20, name: "x", status: "completed", conclusion: "success" }, { id: 21, name: "x", status: "completed", conclusion: "cancelled" });
    }],
    ["a failure under a newer success", "checks_failed", () => {
      fake.runs.push({ id: 20, name: "x", status: "completed", conclusion: "failure" }, { id: 21, name: "x", status: "completed", conclusion: "success" });
    }],
    ["a cancelled run replaced only by another app's run", "checks_failed", () => {
      fake.runs.push({ id: 20, name: "x", app: { id: 1 }, status: "completed", conclusion: "cancelled" }, { id: 21, name: "x", app: { id: 2 }, status: "completed", conclusion: "success" });
    }],
    ["a cancelled run whose replacement still runs", "checks_pending", () => {
      fake.runs.push({ id: 20, name: "x", status: "completed", conclusion: "cancelled" }, { id: 21, name: "x", status: "in_progress", conclusion: null });
    }],
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

  test("a cancelled run replaced by a newer success does not block", async () => {
    fake.runs.push({ id: 21, name: "x", status: "completed", conclusion: "success" }, { id: 20, name: "x", status: "completed", conclusion: "cancelled" });
    expect(await go()).toMatchObject({ ok: true });
  });

  test("required checks come from classic protection alone", async () => {
    fake.rules = [];
    fake.branch.protection.required_status_checks = { enforcement_level: "non_admins", contexts: ["validate", "docker"], checks: [] };
    expect(await go()).toMatchObject({ ok: true });
  });

  test("a required check may be a commit status", async () => {
    fake.rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ext" }] } }];
    fake.statuses.push({ context: "ext", state: "success" });
    expect(await go()).toMatchObject({ ok: true });
  });

  test("classic checks left over with enforcement off do not count", async () => {
    fake.branch.protection.required_status_checks = { enforcement_level: "off", contexts: ["gone"], checks: [] };
    expect(await go()).toMatchObject({ ok: true });
  });

  test("disabled classic protection and an unprotected branch add nothing to a ruleset", async () => {
    fake.branch.protection = { enabled: false, required_status_checks: { enforcement_level: "non_admins", contexts: ["gone"], checks: [] } };
    expect(await go()).toMatchObject({ ok: true });
    fake.branch = { protected: false };
    expect(await go()).toMatchObject({ ok: true });
  });

  const malformed: [string, () => void][] = [
    ["a run with no id", () => { fake.runs.push({ name: "x", status: "completed", conclusion: "success" }); }],
    ["a ruleset rule with no list", () => { fake.rules = [{ type: "required_status_checks", parameters: {} }]; }],
    ["a ruleset check with no name", () => { fake.rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }]; }],
    ["rules that are not a list", () => { fake.rules = { message: "x" }; }],
    ["a branch with no protected field", () => { fake.branch = {}; }],
    ["protection with no enabled field", () => { fake.branch = { protected: true, protection: {} }; }],
    ["protection with no enforcement level", () => { fake.branch.protection.required_status_checks = { contexts: [] }; }],
    ["enforced protection with no list", () => { fake.branch.protection.required_status_checks = { enforcement_level: "everyone" }; }],
    ["an empty classic check name", () => { fake.branch.protection.required_status_checks = { enforcement_level: "everyone", contexts: [""] }; }],
  ];
  for (const [name, set] of malformed) {
    test(`${name} is unreadable, not green`, async () => {
      set();
      await expect(go()).rejects.toThrow(Unreadable);
      expect(merged()).toBe(0);
    });
  }

  test("a commented review does not cancel an approval", async () => {
    fake.reviews.push({ user: { login: "claude[bot]" }, state: "COMMENTED", commit_id: HEAD });
    expect(await go()).toMatchObject({ ok: true });
  });

  for (const route of ["GET /repos/mctlhq/r/pulls/7", "GET /repos/mctlhq/r/pulls/7/reviews", `GET /repos/mctlhq/r/commits/${HEAD}/check-runs`, `GET /repos/mctlhq/r/commits/${HEAD}/status`, "GET /repos/mctlhq/r/rules/branches/main", "GET /repos/mctlhq/r/branches/main"]) {
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

describe("merge, read last", () => {
  test("mergeability computed by the time of the last read is enough", async () => {
    fake.pr = { ...fake.pr, mergeable: null, mergeable_state: "unknown" };
    fake.prLater = { ...fake.pr, mergeable: true, mergeable_state: "clean" };
    expect(await merge(cfg, gh, REPO, 7, HEAD)).toMatchObject({ ok: true });
  });
  test("a head that moved during the checks is refused", async () => {
    fake.prLater = { ...fake.pr, head: { sha: "d".repeat(40) } };
    await refused(merge(cfg, gh, REPO, 7, HEAD), "head_moved");
  });
  test("a status list shorter than total_count is unreadable, not green", async () => {
    fake.statusTotal = 31;
    await expect(merge(cfg, gh, REPO, 7, HEAD)).rejects.toThrow(Unreadable);
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

describe("update-branch", () => {
  const own = () => {
    fake.pr.user = { login: "mctl-codex[bot]", type: "Bot" };
    fake.pr.head.repo = { full_name: REPO };
  };
  const updates = () => fake.calls.filter((c) => c.path === "/repos/mctlhq/r/pulls/7/update-branch");

  test("merges main into the App's own PR, pinned to the head, only when it is behind", async () => {
    own();
    expect(await updateBranch(cfg, gh, REPO, 7, HEAD)).toMatchObject({ ok: true, accepted: true, from: HEAD, behind_by: 3 });
    expect(updates().map((c) => [c.method, c.body])).toEqual([["PUT", { expected_head_sha: HEAD }]]);
    fake.behindBy = 0;
    expect(await updateBranch(cfg, gh, REPO, 7, HEAD)).toMatchObject({ ok: true, already: true });
    expect(updates()).toHaveLength(1);
  });

  test("never on someone else's PR, another repository's branch, a moved head or a closed PR", async () => {
    own();
    fake.pr.user = { login: "mashkovd", type: "User" };
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "not_own_pr");
    fake.pr.user = { login: "mctl-codex[bot]", type: "User" };
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "not_own_pr");
    own();
    fake.pr.head.repo = { full_name: "someone/fork" };
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "not_own_pr");
    own();
    fake.pr.head.sha = "b".repeat(40);
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "head_moved");
    fake.pr.head.sha = HEAD;
    fake.pr.state = "closed";
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "not_open");
    fake.pr.state = "open";
    fake.pr.base.ref = "release";
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "wrong_base");
    await refused(updateBranch(cfg, gh, "mctlhq/api", 7, HEAD), "repo_not_allowed");
    expect(updates()).toHaveLength(0);
  });

  test("an unreadable compare is a failed read, a refusal is refused, a lost reply is unknown", async () => {
    own();
    fake.pr.user = {};
    await expect(updateBranch(cfg, gh, REPO, 7, HEAD)).rejects.toThrow(Unreadable);
    own();
    fake.behindBy = null;
    await expect(updateBranch(cfg, gh, REPO, 7, HEAD)).rejects.toThrow(Unreadable);
    expect(updates()).toHaveLength(0);
    fake.behindBy = 2;
    fake.updateReply = { status: 422, body: { message: "expected head sha didn't match current head ref." } };
    await refused(updateBranch(cfg, gh, REPO, 7, HEAD), "update_refused");
    fake.dropUpdate = true;
    await expect(updateBranch(cfg, gh, REPO, 7, HEAD)).rejects.toThrow(OutcomeUnknown);
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

  async function quietly(run: () => Promise<number>): Promise<{ code: number; out: string }> {
    const writeOut = process.stdout.write;
    const writeErr = process.stderr.write;
    let out = "";
    (process.stdout as any).write = (s: string) => ((out += s), true);
    (process.stderr as any).write = (s: string) => ((out += s), true);
    try {
      return { code: await run(), out };
    } finally {
      (process.stdout as any).write = writeOut;
      (process.stderr as any).write = writeErr;
    }
  }
  const publishArgs = (h: { bundle: string; manifest: string }, body: string) => ["publish", "--repo", REPO, "--bundle", h.bundle, "--manifest", h.manifest, "--allow", "src/", "--title", "feat: x", "--body-file", body];
  const pullBodies = () => fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls")).map((c) => c.body.body);

  test("--body-file reads a plain file, so a planted link cannot publish the key", async () => {
    const h = handoff();
    const link = path.join(tmp, "body.md");
    fs.symlinkSync(cfg.keyFile, link);
    expect((await quietly(() => main(publishArgs(h, link), cfg))).code).toBe(3);
    expect(pullBodies()).toEqual([]);
    fs.unlinkSync(link);
    fs.writeFileSync(link, "x".repeat(64 * 1024 + 1));
    expect((await quietly(() => main(publishArgs(h, link), cfg))).code).toBe(3);
    expect(pullBodies()).toEqual([]);
    fs.writeFileSync(link, "the body");
    expect((await quietly(() => main(publishArgs(h, link), cfg))).code).toBe(0);
    expect(pullBodies()).toEqual(["the body"]);
  });

  test("status shows the app, its permissions and the repositories", async () => {
    const r = await quietly(() => main(["status"], cfg));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, app: "mctl-codex", permissions: { contents: "write" }, installed: [REPO], allowed: [REPO] });
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

  test("defaults point at the real App and the repositories slots work on", () => {
    const c = config({ MCTL_BRIDGE_HOME: "/h" });
    expect(c.keyFile).toBe("/h/etc/codex-github-app.pem");
    expect(c.repos).toEqual(["mctlhq/mctl-claude-remote", "mctlhq/bridge-step0-sandbox", "mctlhq/mctl-telegram", "mctlhq/mctl-gitops", "mctlhq/mctl-api", "mctlhq/mctl-agents", "mctlhq/mctl-agent", "mctlhq/mctl-web", "mctlhq/mctl-docs", "mctlhq/mctl-academy", "mctlhq/mctl-alice", "mctlhq/mctl-support", "mctlhq/seerrsense"]);
    expect(c.repos).not.toContain("mctlhq/.github");
  });
});

describe("publish --update-from", () => {
  /** Publish feat/x once as a new PR, then add a commit on top: the update to hand off. */
  async function published(): Promise<{ first: string }> {
    const h = handoff();
    await publish(cfg, gh, opts(h));
    return { first: h.m.head_sha };
  }
  const own = (head: string, over: any = {}) => ({
    number: 7, html_url: "https://x/7", draft: false, user: { login: "mctl-codex[bot]", type: "Bot" },
    head: { sha: head, ref: "feat/x", repo: { full_name: REPO } }, base: { ref: "main" }, ...over,
  });
  const next = (): { bundle: string; manifest: string; head: string } => {
    commit("src/a.txt", "c\n");
    const y = seal("feat/x", base, ["src/a.txt"]);
    return { ...y, head: git(work, "rev-parse", "HEAD") };
  };
  const pulls = () => writes().filter((w) => w.endsWith("/pulls")).length;

  test("fast-forwards the App's own open PR to the new head, opens no PR, and is idempotent", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first)];
    const r = await publish(cfg, gh, { ...opts(y), updateFrom: first });
    expect(r).toMatchObject({ ok: true, pr: 7, head: y.head, branch: "feat/x", updated_from: first });
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${y.head}`);
    expect(pulls()).toBe(1);
    fake.pulls = [own(y.head)];
    expect(await publish(cfg, gh, { ...opts(y), updateFrom: first })).toMatchObject({ ok: true, duplicate: true, pr: 7 });
    expect(pulls()).toBe(1);
  });

  test("without --update-from an occupied branch is still refused", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first)];
    await refused(publish(cfg, gh, opts(y)), "branch_taken");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("the branch must be exactly at the expected head, on GitHub and on the PR", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first)];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: base }), "branch_moved");
    fake.pulls = [own(base)];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "branch_moved");
    // The PR listing can lag behind the branch: it still shows the expected head while the
    // branch itself has moved on. The branch read alone has to refuse this.
    fake.pulls = [own(base)];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: base }), "branch_moved");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("a head that does not descend from the current one is never pushed", async () => {
    const { first } = await published();
    git(work, "checkout", "-q", "-B", "feat/x", base);
    commit("src/a.txt", "other\n");
    const y = seal("feat/x", base, ["src/a.txt"]);
    fake.pulls = [own(first)];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "not_fast_forward");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("a run resumed after its push still checks ancestry and the PR head", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first)];
    await publish(cfg, gh, { ...opts(y), updateFrom: first });
    // The push landed but the ledger never reached "done": the next run resumes.
    const dir = path.join(cfg.home, "publish/ledger");
    const resume = () => {
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        const l = JSON.parse(fs.readFileSync(file, "utf8"));
        if (l.head === y.head) fs.writeFileSync(file, JSON.stringify({ ...l, state: "intent" }));
      }
    };
    resume();
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: "1".repeat(40) }), "not_fast_forward");
    resume();
    fake.pulls = [own(base)];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "branch_moved");
    for (const prHead of [y.head, first]) {
      resume();
      fake.pulls = [own(prHead)];
      expect(await publish(cfg, gh, { ...opts(y), updateFrom: first })).toMatchObject({ ok: true, pr: 7, updated_from: first });
    }
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${y.head}`);
  });

  test("no refs from the bundle stay behind after an update", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first)];
    await publish(cfg, gh, { ...opts(y), updateFrom: first });
    expect(git(path.join(cfg.home, "publish/cache/mctlhq__r.git"), "for-each-ref", "refs/publish/")).toBe("");
  });

  test("a refused push is push_refused, and an unreadable branch after it is outcome unknown", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first)];
    const hook = path.join(remote, "hooks/pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "push_refused");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
    // The hook moves the repository away and then refuses: the read-back cannot happen.
    fs.writeFileSync(hook, `#!/bin/sh\nmv "${remote}" "${remote}.gone"\nexit 1\n`, { mode: 0o755 });
    const err = await publish(cfg, gh, { ...opts(y), updateFrom: first }).catch((e) => e);
    fs.renameSync(`${remote}.gone`, remote);
    expect(err).toBeInstanceOf(OutcomeUnknown);
    fs.rmSync(hook);
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("only the App's own PR from this repository, on main, is updated", async () => {
    const { first } = await published();
    const y = next();
    const cases: [any, string][] = [
      [own(first, { user: { login: "mashkovd", type: "User" } }), "not_own_pr"],
      [own(first, { user: { login: "dependabot[bot]", type: "Bot" } }), "not_own_pr"],
      [own(first, { user: { login: "mctl-codex[bot]", type: "User" } }), "not_own_pr"],
      [own(first, { head: { sha: first, ref: "feat/x", repo: { full_name: "someone/fork" } } }), "not_own_pr"],
      [own(first, { base: { ref: "release" } }), "wrong_base"],
    ];
    for (const [pr, code] of cases) {
      fake.pulls = [pr];
      await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), code);
    }
    fake.pulls = [];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "no_open_pr");
    fake.pulls = [own(first), own(first, { number: 8 })];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "ambiguous_pr");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("there must be a branch to update", async () => {
    const h = handoff();
    fake.pulls = [own(base)];
    await refused(publish(cfg, gh, { ...opts(h), updateFrom: base }), "no_branch");
    expect(remoteRefs()).not.toContain("refs/heads/feat/x");
  });

  test("the commit checks still run on the whole range before anything is pushed", async () => {
    const { first } = await published();
    fs.writeFileSync(path.join(work, "src/a.txt"), "c\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "fix: c\n\nCo-Authored-By: x <x@x>");
    const y = seal("feat/x", base, ["src/a.txt"]);
    fake.pulls = [own(first)];
    await refused(publish(cfg, gh, { ...opts(y), updateFrom: first }), "co_authored_by");
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("an unreadable App slug or PR author is a failed read, not permission", async () => {
    const { first } = await published();
    const y = next();
    fake.pulls = [own(first, { user: {} })];
    expect(await publish(cfg, gh, { ...opts(y), updateFrom: first }).catch((e) => e)).toBeInstanceOf(Unreadable);
    fake.pulls = [own(first)];
    for (const app of [{}, { slug: "" }, { slug: 7 }]) {
      fake.app = app;
      expect(await publish(cfg, gh, { ...opts(y), updateFrom: first }).catch((e) => e)).toBeInstanceOf(Unreadable);
    }
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${first}`);
  });

  test("the CLI takes --update-from only as a full SHA", async () => {
    const { first } = await published();
    const y = next();
    const body = path.join(tmp, "body.md");
    fs.writeFileSync(body, "b");
    const writeErr = process.stderr.write;
    const writeOut = process.stdout.write;
    let out = "";
    (process.stderr as any).write = () => true;
    (process.stdout as any).write = (s: string) => ((out += s), true);
    const argv = ["publish", "--repo", REPO, "--bundle", y.bundle, "--manifest", y.manifest, "--allow", "src/", "--title", "t", "--body-file", body];
    try {
      expect(await main([...argv, "--update-from", first.slice(0, 12)], cfg)).toBe(1);
      fake.pulls = [own(first)];
      expect(await main([...argv, "--update-from", first], cfg)).toBe(0);
    } finally {
      (process.stderr as any).write = writeErr;
      (process.stdout as any).write = writeOut;
    }
    expect(out).toContain(`"updated_from":"${first}"`);
    expect(remoteRefs()).toContain(`refs/heads/feat/x ${y.head}`);
  });
});

test("the source offers no way to approve, force or bypass", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "publish.ts"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const bad of ['"APPROVE"', "--force", '"-f"', "--admin", "/reviews`, {"]) expect(code, bad).not.toContain(bad);
});
