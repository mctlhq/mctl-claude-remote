// The slot's export (src/handoff.ts) on throwaway git repositories and private directories.
// No real handoff directory, credential, bridge state, network or GitHub is involved; the
// publisher's own reader (parseManifest) and git itself are the judges of compatibility.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HandoffError, MAX_BUNDLE_BYTES, MAX_MANIFEST_BYTES, SimulatedCrash, exportHandoff, limits, main } from "../src/handoff.ts";
import type { ExportInput, ExportOptions } from "../src/handoff.ts";
import { parseManifest } from "../src/publish.ts";

const ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent",
};

function git(cwd: string, ...a: string[]): string {
  const r = spawnSync("git", a, { cwd, env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit the given files (null deletes), executable when the name ends in .sh. */
function commit(dir: string, files: Record<string, string | null>, msg: string): string {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    if (content === null) {
      fs.rmSync(full);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (name.endsWith(".sh")) fs.chmodSync(full, 0o755);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

const BRANCH = "feat/slot-export";
const REPO = "mctlhq/example";

type Fx = { src: string; root: string; base: string; head: string; input: ExportInput };
let tmp: string;
let n = 0;

function fixture(): Fx {
  const src = path.join(tmp, `src${n++}`);
  fs.mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  const base = commit(src, { "README.md": "hello\n" }, "base");
  git(src, "checkout", "-q", "-b", BRANCH);
  commit(src, { "a.txt": "one\n" }, "add a");
  const head = commit(src, { "dir/b.sh": "#!/bin/sh\necho b\n", "a.txt": "two\n" }, "add b, change a");
  const root = path.join(tmp, `handoff${n++}`);
  fs.mkdirSync(root, { mode: 0o700 });
  return { src, root, base, head, input: { repoPath: src, handoffRoot: root, taskId: "t-1", attemptId: "a-1", repo: REPO, baseSha: base, headSha: head, branch: BRANCH } };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function refused(p: Promise<unknown>): Promise<HandoffError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HandoffError);
    return err as HandoffError;
  }
  throw new Error("expected a refusal");
}

const listing = (dir: string): string[] => fs.readdirSync(dir).sort();
const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** Everything in a directory, by name, with a hash of each file: to prove nothing was touched. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(listing(dir).map((f) => {
    const st = fs.lstatSync(path.join(dir, f));
    return [f, st.isFile() ? `${st.ino}:${sha(path.join(dir, f))}` : st.isSymbolicLink() ? `link:${fs.readlinkSync(path.join(dir, f))}` : "other"];
  }));
}

describe("a successful export", () => {
  test("writes a bundle and a publisher-readable manifest and describes them", async () => {
    const f = fixture();
    const r = await exportHandoff(f.input);
    expect(listing(f.root)).toEqual(["t-1.bundle", "t-1.manifest.json"]);
    expect(r).toMatchObject({
      ok: true, idempotent: false, task_id: "t-1", attempt_id: "a-1", repo: REPO, base_sha: f.base, head_sha: f.head, branch: BRANCH,
      bundle_path: path.join(f.root, "t-1.bundle"), manifest_path: path.join(f.root, "t-1.manifest.json"),
    });
    expect(r.changed_files).toEqual(["a.txt", "dir/b.sh"]);
    expect(r.sha256).toBe(sha(r.bundle_path));
    expect(r.bundle_bytes).toBe(fs.statSync(r.bundle_path).size);

    const raw = fs.readFileSync(r.manifest_path);
    const m = parseManifest(raw); // the publisher's own reader
    expect(Object.keys(JSON.parse(raw.toString())).sort()).toEqual(["attempt_id", "base_sha", "branch", "changed_files", "head_sha", "repo", "sha256", "task_id"]);
    expect(m).toEqual({ task_id: "t-1", attempt_id: "a-1", repo: REPO, base_sha: f.base, head_sha: f.head, branch: BRANCH, changed_files: ["a.txt", "dir/b.sh"], sha256: r.sha256 });
  });

  test("the bundle imports the head above its declared base and keeps every commit id", async () => {
    const f = fixture();
    const r = await exportHandoff(f.input);
    // A repository that has the base and nothing else, as the publisher's cache does.
    const dest = path.join(tmp, "dest");
    fs.mkdirSync(dest);
    git(dest, "init", "-q", "-b", "scratch");
    git(dest, "fetch", "-q", f.src, "main:refs/heads/main");
    expect(git(dest, "rev-parse", "main")).toBe(f.base);
    expect(spawnSync("git", ["cat-file", "-e", `${f.head}^{commit}`], { cwd: dest, env: ENV }).status).not.toBe(0);

    expect(spawnSync("git", ["bundle", "verify", r.bundle_path], { cwd: dest, env: ENV }).status).toBe(0);
    expect(git(dest, "bundle", "list-heads", r.bundle_path).split("\n").map((l) => l.split(" ")[0])).toContain(f.head);
    git(dest, "fetch", "-q", "--no-tags", r.bundle_path, "+refs/heads/*:refs/publish/t-1/*");
    expect(git(dest, "rev-parse", `refs/publish/t-1/${BRANCH}`)).toBe(f.head);
    // The same commits, byte for byte: same ids, in the same order.
    expect(git(dest, "rev-list", `${f.base}..${f.head}`)).toBe(git(f.src, "rev-list", `${f.base}..${f.head}`));
    expect(git(dest, "diff", "--raw", "--no-abbrev", f.base, f.head)).toBe(git(f.src, "diff", "--raw", "--no-abbrev", f.base, f.head));
  });

  test("leaves the source tree, index and refs exactly as they were", async () => {
    const f = fixture();
    const before = { index: sha(path.join(f.src, ".git", "index")), status: git(f.src, "status", "--porcelain=v2", "--branch"), refs: git(f.src, "for-each-ref"), tree: git(f.src, "ls-files", "-s"), a: sha(path.join(f.src, "a.txt")) };
    await exportHandoff(f.input);
    expect({ index: sha(path.join(f.src, ".git", "index")), status: git(f.src, "status", "--porcelain=v2", "--branch"), refs: git(f.src, "for-each-ref"), tree: git(f.src, "ls-files", "-s"), a: sha(path.join(f.src, "a.txt")) }).toEqual(before);
  });

  test("leaves no reservation or temporary file behind", async () => {
    const f = fixture();
    await exportHandoff(f.input);
    expect(listing(f.root).filter((x) => x.endsWith(".lock") || x.endsWith(".tmp"))).toEqual([]);
  });

  test("an export of one task does not disturb another's", async () => {
    const f = fixture();
    await exportHandoff(f.input);
    const other = await exportHandoff({ ...f.input, taskId: "t-2", attemptId: "a-9" });
    expect(listing(f.root)).toEqual(["t-1.bundle", "t-1.manifest.json", "t-2.bundle", "t-2.manifest.json"]);
    expect(other.attempt_id).toBe("a-9");
  });
});

describe("inputs", () => {
  const cases: [string, Partial<ExportInput>][] = [
    ["traversing task id", { taskId: "../x" }],
    ["task id with a slash", { taskId: "a/b" }],
    ["empty task id", { taskId: "" }],
    ["dot-dot task id", { taskId: ".." }],
    ["task id over 100 characters", { taskId: "x".repeat(101) }],
    ["attempt id with a space", { attemptId: "a 1" }],
    ["repo without an owner", { repo: "example" }],
    ["repo with a traversal", { repo: "../etc" }],
    ["upper-case sha", { baseSha: "A".repeat(40) }],
    ["short sha", { headSha: "abc123" }],
    ["branch outside the allowed prefixes", { branch: "main" }],
    ["branch with ..", { branch: "feat/a..b" }],
    ["branch with //", { branch: "feat//x" }],
    ["branch ending in .lock", { branch: "feat/x.lock" }],
    ["relative repo path", { repoPath: "src" }],
    ["relative handoff root", { handoffRoot: "handoff" }],
  ];
  for (const [name, patch] of cases) {
    test(`refuses ${name}`, async () => {
      const f = fixture();
      const err = await refused(exportHandoff({ ...f.input, ...patch }));
      expect(err.code).toBe("bad_input");
      expect(listing(f.root)).toEqual([]);
    });
  }

  test("refuses a base that is the head", async () => {
    const f = fixture();
    expect((await refused(exportHandoff({ ...f.input, baseSha: f.head }))).code).toBe("bad_input");
  });

  test("a size cap must be a positive integer, and the hard caps cannot be raised", () => {
    expect(MAX_BUNDLE_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_MANIFEST_BYTES).toBe(256 * 1024);
    expect(limits()).toEqual({ bundle: MAX_BUNDLE_BYTES, manifest: MAX_MANIFEST_BYTES });
    expect(limits({ maxBundleBytes: 2 ** 40, maxManifestBytes: 2 ** 40 })).toEqual({ bundle: MAX_BUNDLE_BYTES, manifest: MAX_MANIFEST_BYTES });
    expect(limits({ maxBundleBytes: 1000, maxManifestBytes: 500 })).toEqual({ bundle: 1000, manifest: 500 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => limits({ maxBundleBytes: bad })).toThrow(HandoffError);
    }
  });
});

describe("the source", () => {
  test("refuses a head that is not where the branch is", async () => {
    const f = fixture();
    const earlier = git(f.src, "rev-parse", "HEAD~1");
    const err = await refused(exportHandoff({ ...f.input, headSha: earlier }));
    expect(err.code).toBe("branch_mismatch");
    expect(listing(f.root)).toEqual([]);
  });

  test("refuses a branch that does not exist", async () => {
    const f = fixture();
    expect((await refused(exportHandoff({ ...f.input, branch: "feat/other" }))).code).toBe("branch_mismatch");
  });

  test("refuses when the checked-out commit is not the head", async () => {
    const f = fixture();
    git(f.src, "checkout", "-q", "main");
    expect((await refused(exportHandoff(f.input))).code).toBe("branch_mismatch");
  });

  test("refuses a base that is not an ancestor of the head", async () => {
    const f = fixture();
    git(f.src, "checkout", "-q", "-b", "side", f.base);
    const side = commit(f.src, { "side.txt": "x\n" }, "side");
    git(f.src, "checkout", "-q", BRANCH);
    expect((await refused(exportHandoff({ ...f.input, baseSha: side }))).code).toBe("base_not_ancestor");
  });

  test("refuses a base commit the repository does not have", async () => {
    const f = fixture();
    expect((await refused(exportHandoff({ ...f.input, baseSha: "1".repeat(40) }))).code).toBe("base_missing");
  });

  for (const [name, dirty] of [
    ["an untracked file", (d: string) => fs.writeFileSync(path.join(d, "new.txt"), "x")],
    ["an unstaged edit", (d: string) => fs.appendFileSync(path.join(d, "a.txt"), "x")],
    ["a staged change", (d: string) => { fs.appendFileSync(path.join(d, "a.txt"), "x"); git(d, "add", "a.txt"); }],
    ["a staged deletion", (d: string) => git(d, "rm", "-q", "a.txt")],
  ] as [string, (d: string) => void][]) {
    test(`refuses ${name}`, async () => {
      const f = fixture();
      dirty(f.src);
      const err = await refused(exportHandoff(f.input));
      expect(err.code).toBe("source_dirty");
      expect(listing(f.root)).toEqual([]);
    });
  }

  test("refuses a repo path that is not the top of a work tree, or is a link", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.src, "sub"));
    expect((await refused(exportHandoff({ ...f.input, repoPath: path.join(f.src, "sub") }))).code).toBe("bad_input");
    const link = path.join(tmp, "srclink");
    fs.symlinkSync(f.src, link);
    expect((await refused(exportHandoff({ ...f.input, repoPath: link }))).code).toBe("bad_input");
  });

  test("refuses a workflow change, also one that a later commit reverts", async () => {
    const f = fixture();
    commit(f.src, { ".github/workflows/ci.yml": "on: push\n" }, "add workflow");
    const head = commit(f.src, { ".github/workflows/ci.yml": null }, "remove it again");
    const err = await refused(exportHandoff({ ...f.input, headSha: head }));
    expect(err.code).toBe("workflow_change");
    expect(listing(f.root)).toEqual([]);
  });

  test("refuses a workflow path in any letter case", async () => {
    const f = fixture();
    const head = commit(f.src, { ".GitHub/Workflows/x.yml": "a\n" }, "odd case");
    expect((await refused(exportHandoff({ ...f.input, headSha: head }))).code).toBe("workflow_change");
  });

  test("refuses a symbolic link", async () => {
    const f = fixture();
    fs.symlinkSync("/etc/passwd", path.join(f.src, "link"));
    git(f.src, "add", "link");
    git(f.src, "commit", "-q", "-m", "link");
    const err = await refused(exportHandoff({ ...f.input, headSha: git(f.src, "rev-parse", "HEAD") }));
    expect(err.code).toBe("forbidden_mode");
  });

  test("refuses a link that a later commit replaces with a file", async () => {
    const f = fixture();
    fs.symlinkSync("target", path.join(f.src, "link"));
    git(f.src, "add", "link");
    git(f.src, "commit", "-q", "-m", "link");
    fs.rmSync(path.join(f.src, "link"));
    const head = commit(f.src, { link: "now a file\n" }, "file");
    expect((await refused(exportHandoff({ ...f.input, headSha: head }))).code).toBe("forbidden_mode");
  });

  test("refuses a submodule entry", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.src, "vendored")); // an uninitialised submodule: an empty directory, which status calls clean
    git(f.src, "update-index", "--add", "--cacheinfo", `160000,${f.base},vendored`);
    git(f.src, "commit", "-q", "-m", "gitlink");
    const err = await refused(exportHandoff({ ...f.input, headSha: git(f.src, "rev-parse", "HEAD") }));
    expect(err.code).toBe("forbidden_mode");
  });

  test("refuses a path with a control character", async () => {
    const f = fixture();
    const head = commit(f.src, { "odd\nname.txt": "x\n" }, "newline in a name");
    expect((await refused(exportHandoff({ ...f.input, headSha: head }))).code).toBe("bad_path");
  });

  test("refuses a merge commit", async () => {
    const f = fixture();
    git(f.src, "checkout", "-q", "-b", "side", f.base);
    commit(f.src, { "side.txt": "x\n" }, "side");
    git(f.src, "checkout", "-q", BRANCH);
    git(f.src, "merge", "-q", "--no-ff", "-m", "merge", "side");
    expect((await refused(exportHandoff({ ...f.input, headSha: git(f.src, "rev-parse", "HEAD") }))).code).toBe("merge_commit");
  });

  test("refuses a range whose final diff is empty", async () => {
    const f = fixture();
    commit(f.src, { "tmp.txt": "x\n" }, "add");
    const head = commit(f.src, { "tmp.txt": null }, "remove");
    expect((await refused(exportHandoff({ ...f.input, baseSha: f.head, headSha: head }))).code).toBe("no_changes");
  });

  test("does not run a configured fsmonitor, external diff or hook", async () => {
    const f = fixture();
    const marker = path.join(tmp, "ran");
    const script = path.join(tmp, "evil.sh");
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(f.src, "config", "core.fsmonitor", script);
    git(f.src, "config", "diff.external", script);
    git(f.src, "config", "core.hooksPath", path.join(tmp, "hooks"));
    fs.mkdirSync(path.join(tmp, "hooks"));
    for (const h of ["reference-transaction", "post-checkout", "pre-auto-gc"]) fs.writeFileSync(path.join(tmp, "hooks", h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await exportHandoff(f.input);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("the handoff directory", () => {
  test("refuses a root that does not exist, and creates nothing", async () => {
    const f = fixture();
    const gone = path.join(tmp, "nope");
    expect((await refused(exportHandoff({ ...f.input, handoffRoot: gone }))).code).toBe("bad_root");
    expect(fs.existsSync(gone)).toBe(false);
  });

  test("refuses a root that is a file or a symbolic link", async () => {
    const f = fixture();
    const file = path.join(tmp, "file");
    fs.writeFileSync(file, "x");
    expect((await refused(exportHandoff({ ...f.input, handoffRoot: file }))).code).toBe("bad_root");
    const link = path.join(tmp, "rootlink");
    fs.symlinkSync(f.root, link);
    expect((await refused(exportHandoff({ ...f.input, handoffRoot: link }))).code).toBe("bad_root");
    expect(listing(f.root)).toEqual([]);
  });

  test("refuses a root under a symbolic link a user planted", async () => {
    const f = fixture();
    const link = path.join(tmp, "up");
    fs.symlinkSync(tmp, link);
    expect((await refused(exportHandoff({ ...f.input, handoffRoot: path.join(link, path.basename(f.root)) }))).code).toBe("unsafe_path");
    expect(listing(f.root)).toEqual([]);
  });

  test("refuses a root that group or others can write", async () => {
    const f = fixture();
    fs.chmodSync(f.root, 0o770);
    expect((await refused(exportHandoff(f.input))).code).toBe("bad_root");
    fs.chmodSync(f.root, 0o707);
    expect((await refused(exportHandoff(f.input))).code).toBe("bad_root");
    expect(listing(f.root)).toEqual([]);
  });

  test("does not change the root's mode", async () => {
    const f = fixture();
    fs.chmodSync(f.root, 0o750);
    await exportHandoff(f.input);
    expect(fs.statSync(f.root).mode & 0o777).toBe(0o750);
  });
});

describe("size caps", () => {
  test("a bundle over the cap is refused and leaves nothing", async () => {
    const f = fixture();
    const err = await refused(exportHandoff(f.input, { maxBundleBytes: 100 }));
    expect(err.code).toBe("too_large");
    expect(listing(f.root)).toEqual([]);
  });

  test("a manifest over the cap is refused, with no marker and no bundle left", async () => {
    const f = fixture();
    const err = await refused(exportHandoff(f.input, { maxManifestBytes: 50 }));
    expect(err.code).toBe("too_large");
    expect(listing(f.root)).toEqual([]);
  });

  test("a bundle exactly at its size is accepted", async () => {
    const f = fixture();
    const probe = await exportHandoff(f.input);
    fs.rmSync(probe.bundle_path);
    fs.rmSync(probe.manifest_path);
    const r = await exportHandoff(f.input, { maxBundleBytes: probe.bundle_bytes });
    expect(r.bundle_bytes).toBe(probe.bundle_bytes);
  });
});

describe("temporary names and existing outputs", () => {
  test("a planted link at the temporary name is refused, followed nowhere and left in place", async () => {
    const f = fixture();
    const victim = path.join(tmp, "victim");
    fs.writeFileSync(victim, "precious");
    const planted = path.join(f.root, ".t-1.bundle.dead.tmp");
    fs.symlinkSync(victim, planted);
    const err = await refused(exportHandoff(f.input, { randomHex: () => "dead" }));
    expect(err.code).toBe("output_unsafe");
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
    expect(listing(f.root)).toEqual([".t-1.bundle.dead.tmp"]);
  });

  test("a planted file at the temporary manifest name is refused and left in place", async () => {
    const f = fixture();
    const planted = path.join(f.root, ".t-1.manifest.json.dead.tmp");
    fs.writeFileSync(planted, "someone else's");
    const err = await refused(exportHandoff(f.input, { randomHex: () => "dead" }));
    expect(err.code).toBe("output_unsafe");
    expect(fs.readFileSync(planted, "utf8")).toBe("someone else's");
    // The bundle this call had linked is its own and is taken back; the marker never appeared.
    expect(listing(f.root)).toEqual([".t-1.manifest.json.dead.tmp"]);
  });

  const leftovers: [string, (root: string, victim: string) => void, string][] = [
    ["a bundle with no manifest", (r) => fs.writeFileSync(path.join(r, "t-1.bundle"), "half"), "output_partial"],
    ["a manifest with no bundle", (r) => fs.writeFileSync(path.join(r, "t-1.manifest.json"), "{}"), "output_conflict"],
    ["a garbage manifest beside a bundle", (r) => { fs.writeFileSync(path.join(r, "t-1.manifest.json"), "not json"); fs.writeFileSync(path.join(r, "t-1.bundle"), "x"); }, "output_conflict"],
    ["a manifest that is a symbolic link", (r, v) => fs.symlinkSync(v, path.join(r, "t-1.manifest.json")), "output_unsafe"],
    ["a bundle that is a symbolic link", (r, v) => fs.symlinkSync(v, path.join(r, "t-1.bundle")), "output_unsafe"],
    ["a manifest that is a directory", (r) => fs.mkdirSync(path.join(r, "t-1.manifest.json")), "output_unsafe"],
    ["a bundle that is a directory", (r) => fs.mkdirSync(path.join(r, "t-1.bundle")), "output_unsafe"],
  ];
  for (const [name, plant, code] of leftovers) {
    test(`refuses ${name} and touches none of it`, async () => {
      const f = fixture();
      const victim = path.join(tmp, "victim");
      fs.writeFileSync(victim, "precious");
      plant(f.root, victim);
      const before = snapshot(f.root);
      expect((await refused(exportHandoff(f.input))).code).toBe(code);
      expect(snapshot(f.root)).toEqual(before);
      expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    });
  }

  test("an identical complete export is an idempotent success that writes nothing", async () => {
    const f = fixture();
    const first = await exportHandoff(f.input);
    const before = snapshot(f.root);
    const again = await exportHandoff(f.input);
    expect(again).toEqual({ ...first, idempotent: true });
    expect(snapshot(f.root)).toEqual(before);
  });

  test("an existing bundle that no longer matches its manifest is a conflict, not a success", async () => {
    const f = fixture();
    await exportHandoff(f.input);
    fs.appendFileSync(path.join(f.root, "t-1.bundle"), "x");
    const before = snapshot(f.root);
    expect((await refused(exportHandoff(f.input))).code).toBe("output_conflict");
    expect(snapshot(f.root)).toEqual(before);
  });

  test("a different attempt for the same task is a conflict", async () => {
    const f = fixture();
    await exportHandoff(f.input);
    const before = snapshot(f.root);
    const err = await refused(exportHandoff({ ...f.input, attemptId: "a-2" }));
    expect(err.code).toBe("output_conflict");
    expect(err.message).toContain("a-1");
    expect(snapshot(f.root)).toEqual(before);
  });

  test("a different head for the same task is a conflict", async () => {
    const f = fixture();
    await exportHandoff(f.input);
    const before = snapshot(f.root);
    const head = commit(f.src, { "more.txt": "x\n" }, "another commit");
    expect((await refused(exportHandoff({ ...f.input, headSha: head }))).code).toBe("output_conflict");
    expect(snapshot(f.root)).toEqual(before);
  });

  test("a manifest whose claims were edited to match is still checked against its bundle", async () => {
    const f = fixture();
    const r = await exportHandoff(f.input);
    const m = JSON.parse(fs.readFileSync(r.manifest_path, "utf8"));
    m.sha256 = "0".repeat(64);
    fs.writeFileSync(r.manifest_path, JSON.stringify(m));
    expect((await refused(exportHandoff(f.input))).code).toBe("output_conflict");
  });
});

describe("the manifest is the final marker", () => {
  test("no manifest exists while the bundle is being put in place, and it matches the bundle when it appears", async () => {
    const f = fixture();
    const seen: { manifest: boolean; bundle: boolean; bundleSha: string | null }[] = [];
    const r = await exportHandoff(f.input, {
      hooks: {
        afterReserve: () => seen.push({ manifest: fs.existsSync(path.join(f.root, "t-1.manifest.json")), bundle: fs.existsSync(path.join(f.root, "t-1.bundle")), bundleSha: null }),
        afterBundleLink: () => seen.push({ manifest: fs.existsSync(path.join(f.root, "t-1.manifest.json")), bundle: true, bundleSha: sha(path.join(f.root, "t-1.bundle")) }),
        beforeManifestLink: () => seen.push({ manifest: fs.existsSync(path.join(f.root, "t-1.manifest.json")), bundle: true, bundleSha: sha(path.join(f.root, "t-1.bundle")) }),
      },
    });
    expect(seen.map((s) => s.manifest)).toEqual([false, false, false]);
    expect(seen[0]!.bundle).toBe(false);
    expect(seen[1]!.bundleSha).toBe(r.sha256);
    expect(parseManifest(fs.readFileSync(r.manifest_path)).sha256).toBe(sha(r.bundle_path));
  });

  test("killed between the bundle and the manifest: a bundle but no marker, and the task stays reserved", async () => {
    const f = fixture();
    await expect(exportHandoff(f.input, { hooks: { afterBundleLink: () => { throw new SimulatedCrash("killed"); } } })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(fs.existsSync(path.join(f.root, "t-1.bundle"))).toBe(true);
    expect(fs.existsSync(path.join(f.root, "t-1.manifest.json"))).toBe(false);
    // The publisher would find no manifest: nothing is ready.
    expect(listing(f.root).filter((x) => x.endsWith(".manifest.json"))).toEqual([]);

    const before = snapshot(f.root);
    expect((await refused(exportHandoff(f.input))).code).toBe("busy");
    expect((await refused(exportHandoff({ ...f.input, attemptId: "a-2" }))).code).toBe("busy");
    expect(snapshot(f.root)).toEqual(before);

    // After an operator clears the leftovers, the export goes through.
    for (const f2 of listing(f.root)) fs.rmSync(path.join(f.root, f2));
    const r = await exportHandoff(f.input);
    expect(fs.existsSync(r.manifest_path)).toBe(true);
  });

  test("killed after the temporary manifest is written but before it is linked: still no marker", async () => {
    const f = fixture();
    await expect(exportHandoff(f.input, { randomHex: () => "cafe", hooks: { beforeManifestLink: () => { throw new SimulatedCrash("killed"); } } })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(fs.existsSync(path.join(f.root, "t-1.manifest.json"))).toBe(false);
    expect(listing(f.root).filter((x) => x === "t-1.manifest.json")).toEqual([]);
    expect(fs.existsSync(path.join(f.root, ".t-1.manifest.json.cafe.tmp"))).toBe(true);
  });

  test("an ordinary failure before the marker takes back the bundle this call made", async () => {
    const f = fixture();
    await expect(exportHandoff(f.input, { hooks: { beforeManifestLink: () => { throw new Error("disk full"); } } })).rejects.toBeInstanceOf(HandoffError);
    expect(listing(f.root)).toEqual([]);
  });

  test("a bundle changed after it was hashed is never given a marker", async () => {
    const f = fixture();
    const err = await refused(exportHandoff(f.input, { hooks: { beforeManifestLink: () => fs.appendFileSync(path.join(f.root, "t-1.bundle"), "tampered") } }));
    expect(err.code).toBe("output_conflict");
    expect(fs.existsSync(path.join(f.root, "t-1.manifest.json"))).toBe(false);
  });

  test("a bundle swapped for another file after it was hashed is never given a marker and is not deleted", async () => {
    const f = fixture();
    const err = await refused(exportHandoff(f.input, {
      hooks: { beforeManifestLink: () => { fs.rmSync(path.join(f.root, "t-1.bundle")); fs.writeFileSync(path.join(f.root, "t-1.bundle"), "someone else's file"); } },
    }));
    expect(err.code).toBe("output_conflict");
    expect(fs.existsSync(path.join(f.root, "t-1.manifest.json"))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, "t-1.bundle"), "utf8")).toBe("someone else's file");
  });

  test("a replacement that reuses the bundle's inode number is still not deleted", async () => {
    // Deterministic on any file system: the seam makes cleanup see the replacement with the
    // original device and inode, which is what a reused inode number looks like to a stat call.
    const f = fixture();
    const bundle = path.join(f.root, "t-1.bundle");
    let original: fs.Stats | null = null;
    const err = await refused(exportHandoff(f.input, {
      hooks: {
        beforeManifestLink: () => {
          original = fs.lstatSync(bundle);
          fs.rmSync(bundle);
          fs.writeFileSync(bundle, "someone else's file");
        },
      },
      statEntry: (file) => (file === bundle && original ? { isFile: () => true, dev: original.dev, ino: original.ino } : fs.lstatSync(file)),
    }));
    expect(err.code).toBe("output_conflict");
    expect(original).not.toBeNull();
    expect(fs.existsSync(path.join(f.root, "t-1.manifest.json"))).toBe(false);
    expect(fs.readFileSync(bundle, "utf8")).toBe("someone else's file");
  });

  describe("a manifest write that stops part-way", () => {
    const tmpManifest = ".t-1.manifest.json.cafe.tmp";
    /** Writes `first` bytes for real, then lets `then` run on the second call. No disk is filled. */
    const partial = (first: number, then: (fd: number, buf: Buffer, offset: number) => number) => {
      let calls = 0;
      return (fd: number, buf: Buffer, offset: number, length: number): number => {
        if (calls++ === 0) return fs.writeSync(fd, buf, offset, Math.min(first, length));
        return then(fd, buf, offset);
      };
    };
    const enospc = (): never => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };

    test("a short write then ENOSPC leaves no marker, partial file, bundle or reservation", async () => {
      const f = fixture();
      const err = await refused(exportHandoff(f.input, { randomHex: () => "cafe", writeSync: partial(10, enospc) }));
      expect(err.code).toBe("output_unsafe");
      expect(listing(f.root)).toEqual([]);
    });

    test("a write that threw after putting bytes down is still cleaned up", async () => {
      const f = fixture();
      const err = await refused(exportHandoff(f.input, {
        randomHex: () => "cafe",
        // Bytes reach the file, then the call throws: the count never comes back to the exporter.
        writeSync: (fd, buf, offset, length) => {
          fs.writeSync(fd, buf, offset, Math.min(25, length));
          return enospc();
        },
      }));
      expect(err.code).toBe("output_unsafe");
      expect(listing(f.root)).toEqual([]);
    });

    test("a foreign file that replaced the partial temporary manifest is kept, the rest is cleaned", async () => {
      const f = fixture();
      const mine = path.join(f.root, tmpManifest);
      await refused(exportHandoff(f.input, {
        randomHex: () => "cafe",
        writeSync: partial(10, () => {
          fs.rmSync(mine);
          fs.writeFileSync(mine, "someone else's file");
          return enospc();
        }),
      }));
      expect(listing(f.root)).toEqual([tmpManifest]);
      expect(fs.readFileSync(mine, "utf8")).toBe("someone else's file");
    });

    test("a planted unrelated file is untouched by the cleanup", async () => {
      const f = fixture();
      fs.writeFileSync(path.join(f.root, "t-2.bundle"), "other task");
      await refused(exportHandoff(f.input, { randomHex: () => "cafe", writeSync: partial(10, enospc) }));
      expect(listing(f.root)).toEqual(["t-2.bundle"]);
      expect(fs.readFileSync(path.join(f.root, "t-2.bundle"), "utf8")).toBe("other task");
    });

    test("a write that makes no progress is a refusal, never a complete file", async () => {
      const f = fixture();
      const err = await refused(exportHandoff(f.input, { randomHex: () => "cafe", writeSync: partial(10, () => 0) }));
      expect(err.code).toBe("output_unsafe");
      expect(listing(f.root)).toEqual([]);
    });

    test("short writes that all succeed still produce the complete, valid manifest", async () => {
      const f = fixture();
      const r = await exportHandoff(f.input, { writeSync: (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, Math.min(7, length)) });
      const m = parseManifest(fs.readFileSync(r.manifest_path));
      expect(m.sha256).toBe(r.sha256);
      expect(listing(f.root)).toEqual(["t-1.bundle", "t-1.manifest.json"]);
    });
  });

  test("a manifest that appears from elsewhere is not overwritten", async () => {
    const f = fixture();
    const err = await refused(exportHandoff(f.input, { hooks: { beforeManifestLink: () => fs.writeFileSync(path.join(f.root, "t-1.manifest.json"), "theirs") } }));
    expect(err.code).toBe("output_unsafe");
    expect(fs.readFileSync(path.join(f.root, "t-1.manifest.json"), "utf8")).toBe("theirs");
    expect(fs.existsSync(path.join(f.root, "t-1.bundle"))).toBe(true); // theirs is a manifest: the bundle is not this call's to judge
  });
});

describe("concurrent exporters", () => {
  test("two attempts at one task: one export, the other refused, and the outputs agree", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      exportHandoff({ ...f.input, attemptId: "a-1" }),
      exportHandoff({ ...f.input, attemptId: "a-2" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(["busy", "output_conflict"]).toContain((lost[0]!.reason as HandoffError).code);
    const m = parseManifest(fs.readFileSync(path.join(f.root, "t-1.manifest.json")));
    expect(m.attempt_id).toBe((won[0] as PromiseFulfilledResult<{ attempt_id: string }>).value.attempt_id);
    expect(m.sha256).toBe(sha(path.join(f.root, "t-1.bundle")));
    expect(listing(f.root)).toEqual(["t-1.bundle", "t-1.manifest.json"]);
  });

  test("two identical requests: both end well and nothing is duplicated", async () => {
    const f = fixture();
    const results = await Promise.allSettled([exportHandoff(f.input), exportHandoff(f.input)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as HandoffError).code).toBe("busy");
    expect(listing(f.root)).toEqual(["t-1.bundle", "t-1.manifest.json"]);
  });

  test("different tasks do not block each other", async () => {
    const f = fixture();
    const results = await Promise.all(["t-a", "t-b", "t-c"].map((t) => exportHandoff({ ...f.input, taskId: t })));
    expect(results.map((r) => r.task_id)).toEqual(["t-a", "t-b", "t-c"]);
    expect(listing(f.root).filter((x) => x.endsWith(".manifest.json"))).toHaveLength(3);
  });

  test("an existing reservation is refused and never removed by a loser", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "t-1.export.lock"), "someone-else\n");
    expect((await refused(exportHandoff(f.input))).code).toBe("busy");
    expect(fs.readFileSync(path.join(f.root, "t-1.export.lock"), "utf8")).toBe("someone-else\n");
  });

  test("a reservation that was replaced during the export is not released by this call", async () => {
    const f = fixture();
    const lock = path.join(f.root, "t-1.export.lock");
    await exportHandoff(f.input, { hooks: { afterBundleLink: () => { fs.rmSync(lock); fs.writeFileSync(lock, "another-exporter\n"); } } });
    expect(fs.readFileSync(lock, "utf8")).toBe("another-exporter\n");
  });
});

describe("command line and isolation", () => {
  async function run(argv: string[]): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string | Uint8Array) => (chunks.push(String(s)), true);
    try {
      return { code: await main(argv), out: chunks.join("") };
    } finally {
      process.stdout.write = real;
    }
  }
  const args = (i: ExportInput): string[] => ["export", "--repo-path", i.repoPath, "--handoff-root", i.handoffRoot, "--task-id", i.taskId, "--attempt-id", i.attemptId, "--repo", i.repo, "--base-sha", i.baseSha, "--head-sha", i.headSha, "--branch", i.branch];

  test("prints the export and exits 0", async () => {
    const f = fixture();
    const r = await run(args(f.input));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, task_id: "t-1", head_sha: f.head });
  });

  test("a refusal is JSON with its code and exit 3; a bad command line is exit 1", async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.src, "a.txt"), "x");
    const r = await run(args(f.input));
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "source_dirty" });
    expect((await run(["export", "--task-id", "x"])).code).toBe(1);
    expect((await run(["nonsense"])).code).toBe(1);
  });

  test("the exporter has no network, socket, Valkey or reporting code", () => {
    const text = fs.readFileSync(path.join(import.meta.dir, "..", "src", "handoff.ts"), "utf8");
    const code = text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const forbidden of ["fetch(", "node:net", "node:http", "node:https", "node:dgram", "node:tls", "Bun.connect", "Bun.listen", "valkey", "report_result", "process.env.TELEGRAM", "x-access-token"]) {
      expect(code.includes(forbidden)).toBe(false);
    }
  });
});
