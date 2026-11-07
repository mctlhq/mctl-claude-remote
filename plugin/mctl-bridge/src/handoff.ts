// mctl-handoff: the slot's side of the publish handoff (#127).
//
// A slot turns a finished local branch into the two files `mctl-publish publish` reads, a git
// bundle and a manifest, inside a handoff directory it was explicitly given. This module is
// only the exporter. It does not publish, does not talk to the bridge, Valkey, GitHub or any
// network, takes no credentials and never reports a task's result: the caller supplies the
// identity it was admitted under, and report_result stays the caller's own action. What it
// returns is a description of the files, not a proof of anything; the publisher independently
// checks the audit trail, the remote base, the allowed scope, the hash, the bundle and its
// own ledger.
//
// The manifest is the commit marker. A bundle with no manifest is not an export, so the
// manifest is the last thing to appear, and it appears only after the bundle is in place and
// has been hashed and verified again. The two links are not one atomic step, so an export
// interrupted between them leaves a bundle with no manifest (never the reverse) and a
// reservation that makes every later export of that task refuse until an operator looks.
//
// Everything about the output directory is distrusted the way the publisher distrusts it:
// nothing is followed through a symbolic link, files are created exclusively, and an existing
// output is validated in full or refused, never overwritten.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseManifest, parseRaw } from "./publish.ts";
import type { Manifest } from "./publish.ts";

/** The publisher refuses larger inputs (publish.ts); callers may lower these, never raise them. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;

const SHA = /^[0-9a-f]{40}$/;
const TASK = /^[A-Za-z0-9._-]{1,100}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(feat|fix|ci|docs|chore|refactor|test)\/[A-Za-z0-9._/-]{1,100}$/;
const FILE_MODES = new Set(["100644", "100755", "000000"]);

/** Checked and refused. Nothing the caller owns was changed by this call. */
export class HandoffError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Test seam. A hook that throws this models the process being killed at that point: the
 * exporter rethrows at once, without cleanup and without releasing its reservation.
 */
export class SimulatedCrash extends Error {}

export type ExportInput = {
  /** The slot's own checkout: the work tree's top level. */
  repoPath: string;
  /** An existing directory the slot owns. Never created, never chmod-ed. */
  handoffRoot: string;
  taskId: string;
  attemptId: string;
  /** owner/name, as the manifest and the publisher spell it. */
  repo: string;
  baseSha: string;
  headSha: string;
  branch: string;
};

export type ExportOptions = {
  /** Lower caps for tests. A value above the hard cap is ignored. */
  maxBundleBytes?: number;
  maxManifestBytes?: number;
  /** Replaceable so a test can collide with a temporary name. */
  randomHex?: () => string;
  hooks?: {
    afterReserve?: () => void;
    afterBundleLink?: () => void;
    beforeManifestLink?: () => void;
  };
  /**
   * Test seam: how a name is looked up when deciding whether this call still owns the file there.
   * A test returns another file's identity to model a replacement that reuses an inode number.
   */
  statEntry?: (file: string) => { isFile(): boolean; dev: number; ino: number };
};

export type ExportResult = {
  ok: true;
  /** True when a complete, identical export was already there and nothing was written. */
  idempotent: boolean;
  task_id: string;
  attempt_id: string;
  repo: string;
  base_sha: string;
  head_sha: string;
  branch: string;
  bundle_path: string;
  manifest_path: string;
  sha256: string;
  bundle_bytes: number;
  changed_files: string[];
};

// ── input ──────────────────────────────────────────────────────────────────────────────────

function validate(i: ExportInput): void {
  const bad = (what: string): never => {
    throw new HandoffError("bad_input", what);
  };
  if (typeof i.repoPath !== "string" || !path.isAbsolute(i.repoPath)) bad("repoPath must be an absolute path");
  if (typeof i.handoffRoot !== "string" || !path.isAbsolute(i.handoffRoot)) bad("handoffRoot must be an absolute path");
  if (i.repoPath.includes("\0") || i.handoffRoot.includes("\0")) bad("a path contains NUL");
  if (typeof i.taskId !== "string" || !TASK.test(i.taskId) || i.taskId === "." || i.taskId === "..") bad("taskId");
  if (typeof i.attemptId !== "string" || !TASK.test(i.attemptId)) bad("attemptId");
  if (typeof i.repo !== "string" || !REPO.test(i.repo) || i.repo.split("/").some((part) => part === "." || part === "..")) bad("repo");
  if (typeof i.baseSha !== "string" || !SHA.test(i.baseSha)) bad("baseSha");
  if (typeof i.headSha !== "string" || !SHA.test(i.headSha)) bad("headSha");
  // Exactly the publisher's branch rules (parseManifest), so a refused name is refused here.
  if (typeof i.branch !== "string" || !BRANCH.test(i.branch) || i.branch.includes("..") || i.branch.includes("//") || /(\.lock|\/|\.)$/.test(i.branch)) bad("branch");
  if (i.baseSha === i.headSha) bad("baseSha and headSha are the same commit");
}

function capped(requested: number | undefined, hard: number): number {
  if (requested === undefined) return hard;
  if (!Number.isInteger(requested) || requested <= 0) throw new HandoffError("bad_input", "a size cap must be a positive integer");
  return Math.min(requested, hard);
}

/** The caps in force for these options: never above the publisher's. */
export function limits(opts: ExportOptions = {}): { bundle: number; manifest: number } {
  return { bundle: capped(opts.maxBundleBytes, MAX_BUNDLE_BYTES), manifest: capped(opts.maxManifestBytes, MAX_MANIFEST_BYTES) };
}

// ── git ────────────────────────────────────────────────────────────────────────────────────

// Hooks, credential helpers, the repository's fsmonitor and any optional lock are off, and the
// environment is built from nothing: no GIT_DIR, no user or system configuration.
const GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "--no-optional-locks"];
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

type GitOut = { code: number; out: string; err: string };

function git(cwd: string, ...args: string[]): GitOut {
  const r = spawnSync("git", [...GIT_ARGS, ...args], { cwd, env: GIT_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: (r.stderr ?? "").trim().slice(0, 400) };
}

function must(cwd: string, code: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new HandoffError(code, `git ${args[0]}: ${r.err}`);
  return r.out;
}

function badPath(p: string): string | null {
  if (p === "" || p.length > 4096) return "empty or too long";
  if (p.startsWith("/") || p.includes("\\")) return "absolute or contains a backslash";
  if (/[\x00-\x1f\x7f]/.test(p)) return "contains a control character";
  for (const part of p.split("/")) {
    if (part === "" || part === "." || part === "..") return "has an empty, . or .. component";
    if (part.toLowerCase() === ".git") return "has a .git component";
  }
  return null;
}

type Verified = { changed: string[] };

/** Everything that must be true of the source before a single output file is created. */
function verifySource(i: ExportInput): Verified {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(i.repoPath);
  } catch (err) {
    throw new HandoffError("source_unreadable", `${i.repoPath}: ${(err as Error).message}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HandoffError("bad_input", "repoPath must be a real directory");
  const top = must(i.repoPath, "source_unreadable", "rev-parse", "--show-toplevel").trim();
  if (fs.realpathSync(top) !== fs.realpathSync(i.repoPath)) throw new HandoffError("bad_input", "repoPath is not the top of a work tree");

  const cwd = i.repoPath;
  const tip = git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${i.branch}^{commit}`);
  if (tip.code !== 0) throw new HandoffError("branch_mismatch", `no branch ${i.branch}`);
  if (tip.out.trim() !== i.headSha) throw new HandoffError("branch_mismatch", `${i.branch} is at ${tip.out.trim()}, not ${i.headSha}`);
  const checkedOut = must(cwd, "source_unreadable", "rev-parse", "--verify", "HEAD^{commit}").trim();
  if (checkedOut !== i.headSha) throw new HandoffError("branch_mismatch", `the checked-out commit is ${checkedOut}, not ${i.headSha}`);

  // Staged, unstaged and untracked changes all show up here; ignored files do not, and are not exported.
  const dirty = must(cwd, "source_unreadable", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none");
  if (dirty !== "") throw new HandoffError("source_dirty", "the work tree or index has uncommitted changes");

  if (git(cwd, "cat-file", "-e", `${i.baseSha}^{commit}`).code !== 0) throw new HandoffError("base_missing", i.baseSha);
  if (git(cwd, "merge-base", "--is-ancestor", i.baseSha, i.headSha).code !== 0) throw new HandoffError("base_not_ancestor", `${i.baseSha} is not an ancestor of ${i.headSha}`);

  const range = `${i.baseSha}..${i.headSha}`;
  // Walks every commit, tree and blob in the range: a missing or corrupt object fails here.
  must(cwd, "bad_objects", "rev-list", "--objects", "--quiet", range);
  const merges = must(cwd, "source_unreadable", "rev-list", "--min-parents=2", range).split("\n").filter(Boolean);
  if (merges.length) throw new HandoffError("merge_commit", merges[0]!);

  const diff = (...refs: string[]) => parseRaw(must(cwd, "source_unreadable", "diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", ...refs));
  const final = diff(i.baseSha, i.headSha);
  if (final.length === 0) throw new HandoffError("no_changes", i.headSha);

  // Every commit, not only the final diff: the merge commit lands them all in history.
  const commits = must(cwd, "source_unreadable", "rev-list", range).split("\n").filter(Boolean);
  const touched = commits.flatMap((c) => diff(`${c}^`, c));
  for (const r of touched) {
    const why = badPath(r.path);
    if (why) throw new HandoffError("bad_path", `${JSON.stringify(r.path)}: ${why}`);
    const lower = r.path.toLowerCase();
    if (lower === ".github/workflows" || lower.startsWith(".github/workflows/") || lower === ".github/actions" || lower.startsWith(".github/actions/")) {
      throw new HandoffError("workflow_change", r.path);
    }
    if (!FILE_MODES.has(r.oldMode) || !FILE_MODES.has(r.newMode)) {
      throw new HandoffError("forbidden_mode", `${r.path}: ${r.oldMode} -> ${r.newMode}`);
    }
  }
  return { changed: [...new Set(final.map((r) => r.path))].sort() };
}

// ── the handoff directory ──────────────────────────────────────────────────────────────────

/** A symbolic link above the target that a slot could have planted. Root's own links (/tmp, /var) are not. */
function refuseLinks(file: string): void {
  let cur: string = path.sep;
  for (const part of path.resolve(file).split(path.sep).filter(Boolean).slice(0, -1)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      throw new HandoffError("unsafe_path", `${file}: ${(err as Error).message}`);
    }
    if (st.isSymbolicLink() && st.uid !== 0) throw new HandoffError("unsafe_path", `${file}: ${cur} is a symbolic link`);
  }
}

function checkRoot(root: string): void {
  refuseLinks(root);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch (err) {
    throw new HandoffError("bad_root", `${root}: ${(err as Error).message}`);
  }
  if (st.isSymbolicLink()) throw new HandoffError("bad_root", `${root} is a symbolic link`);
  if (!st.isDirectory()) throw new HandoffError("bad_root", `${root} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new HandoffError("bad_root", `${root} is not owned by this user`);
  if ((st.mode & 0o022) !== 0) throw new HandoffError("bad_root", `${root} is writable by group or others`);
}

const O_CREATE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a regular file is there, without reading it: false for nothing, a refusal for anything else. */
function regularExists(file: string, limit: number): boolean {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HandoffError("output_unsafe", `${file}: ${(err as Error).message}`);
  }
  if (!lst.isFile()) throw new HandoffError("output_unsafe", `${file} is not a regular file`);
  if (lst.size > limit) throw new HandoffError("output_unsafe", `${file}: ${lst.size} bytes, over the ${limit} limit`);
  return true;
}

/** A regular file, no link, bounded; its bytes. null when nothing is there. */
function readRegular(file: string, limit: number): Buffer | null {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HandoffError("output_unsafe", `${file}: ${(err as Error).message}`);
  }
  if (!lst.isFile()) throw new HandoffError("output_unsafe", `${file} is not a regular file`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    throw new HandoffError("output_unsafe", `${file}: ${(err as Error).message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new HandoffError("output_unsafe", `${file} is not a regular file`);
    if (st.size > limit) throw new HandoffError("output_unsafe", `${file}: ${st.size} bytes, over the ${limit} limit`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(file: string, limit: number): { sha256: string; bytes: number } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new HandoffError("output_unsafe", `${file} is not a regular file`);
    if (st.size > limit) throw new HandoffError("too_large", `${file}: ${st.size} bytes, over the ${limit} limit`);
    const h = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      h.update(buf.subarray(0, n));
    }
    return { sha256: h.digest("hex"), bytes: total };
  } finally {
    fs.closeSync(fd);
  }
}

/** A file this call created: its device and inode, and the hash of its bytes once known. */
type Owned = { dev: number; ino: number; sha256: string | null };

/**
 * Whether `file` is still the file this call created: the same device and inode and, once its
 * bytes are known, the same hash. An inode number can go to a replacement once the original is
 * unlinked, so the number alone does not prove ownership.
 */
function isOwned(file: string, owned: Owned, limit: number, stat: (f: string) => { isFile(): boolean; dev: number; ino: number }): boolean {
  try {
    const st = stat(file);
    if (!st.isFile() || st.dev !== owned.dev || st.ino !== owned.ino) return false;
    return owned.sha256 === null || sha256File(file, limit).sha256 === owned.sha256;
  } catch {
    return false;
  }
}

function writeNew(file: string, data: Buffer, created?: (owned: Owned) => void): void {
  const fd = fs.openSync(file, O_CREATE, 0o644);
  const st = fs.fstatSync(fd);
  created?.({ dev: st.dev, ino: st.ino, sha256: null });
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Streams `git bundle create -` into a file this call just created, stopping git at the cap. */
function writeBundle(i: ExportInput, fd: number, cap: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let total = 0;
    let failure: HandoffError | null = null;
    let err = "";
    const child = spawn("git", [...GIT_ARGS, "bundle", "create", "-", `refs/heads/${i.branch}`, `^${i.baseSha}`], { cwd: i.repoPath, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
    const fail = (e: HandoffError) => {
      failure ??= e;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (b: Buffer) => {
      if (failure) return;
      total += b.length;
      if (total > cap) return fail(new HandoffError("too_large", `the bundle is over the ${cap} byte limit`));
      try {
        fs.writeSync(fd, b);
      } catch (e) {
        fail(new HandoffError("output_unsafe", `write: ${(e as Error).message}`));
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 400) err += b.toString("utf8");
    });
    child.on("error", (e) => {
      failure ??= new HandoffError("source_unreadable", `git: ${e.message}`);
    });
    child.on("close", (code) => {
      try {
        if (!failure && code === 0) fs.fsyncSync(fd);
      } catch (e) {
        failure ??= new HandoffError("output_unsafe", `fsync: ${(e as Error).message}`);
      }
      fs.closeSync(fd);
      if (failure) reject(failure);
      else if (code !== 0) reject(new HandoffError("bad_bundle", `git bundle create: ${err.trim().slice(0, 400)}`));
      else resolve();
    });
  });
}

/** The bundle must carry the head, and require exactly the declared base. */
function checkBundle(i: ExportInput, file: string): void {
  const verified = git(i.repoPath, "bundle", "verify", file);
  if (verified.code !== 0) throw new HandoffError("bad_bundle", verified.err);
  const required = [...(verified.out + "\n" + verified.err).matchAll(/requires this ref:\s*([0-9a-f]{40})/g)].map((m) => m[1]);
  if (required.length !== 1 || required[0] !== i.baseSha) throw new HandoffError("bad_bundle", `the bundle requires ${required.join(", ") || "nothing"}, not ${i.baseSha}`);
  const heads = must(i.repoPath, "bad_bundle", "bundle", "list-heads", file).split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  if (!heads.includes(i.headSha)) throw new HandoffError("bad_bundle", `the bundle does not carry ${i.headSha}`);
}

function sameManifest(m: Manifest, want: Manifest): boolean {
  return (
    m.task_id === want.task_id && m.attempt_id === want.attempt_id && m.repo === want.repo && m.base_sha === want.base_sha &&
    m.head_sha === want.head_sha && m.branch === want.branch && JSON.stringify(m.changed_files) === JSON.stringify(want.changed_files)
  );
}

// ── the export ─────────────────────────────────────────────────────────────────────────────

export async function exportHandoff(input: ExportInput, opts: ExportOptions = {}): Promise<ExportResult> {
  validate(input);
  const { bundle: bundleCap, manifest: manifestCap } = limits(opts);
  const hex = opts.randomHex ?? (() => crypto.randomBytes(8).toString("hex"));
  const stat = opts.statEntry ?? ((f: string) => fs.lstatSync(f));
  checkRoot(input.handoffRoot);
  const { changed } = verifySource(input);

  const root = path.resolve(input.handoffRoot);
  const id = input.taskId;
  const bundlePath = path.join(root, `${id}.bundle`);
  const manifestPath = path.join(root, `${id}.manifest.json`);
  const lockPath = path.join(root, `${id}.export.lock`);
  const rand = hex();
  const tmpBundle = path.join(root, `.${id}.bundle.${rand}.tmp`);
  const tmpManifest = path.join(root, `.${id}.manifest.json.${rand}.tmp`);

  const want: Omit<Manifest, "sha256"> = {
    task_id: id, attempt_id: input.attemptId, repo: input.repo, base_sha: input.baseSha, head_sha: input.headSha, branch: input.branch, changed_files: changed,
  };
  const describe = (sha256: string, bytes: number, idempotent: boolean): ExportResult => ({
    ok: true, idempotent, task_id: id, attempt_id: input.attemptId, repo: input.repo, base_sha: input.baseSha, head_sha: input.headSha, branch: input.branch,
    bundle_path: bundlePath, manifest_path: manifestPath, sha256, bundle_bytes: bytes, changed_files: changed,
  });

  // Reserve the task. O_EXCL: of two exporters for one task, exactly one gets past this line.
  const token = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
  try {
    writeNew(lockPath, Buffer.from(`${token}\n${input.attemptId}\n`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new HandoffError("busy", `${id} is being exported, or an earlier export of it was interrupted: ${lockPath}`);
    throw new HandoffError("output_unsafe", `${lockPath}: ${(err as Error).message}`);
  }

  let bundleLinked: Owned | null = null;
  let tmpBundleMade: Owned | null = null;
  let tmpManifestMade: Owned | null = null;
  let crashed = false;
  try {
    opts.hooks?.afterReserve?.();

    // What is already there? Only a complete export identical to this one is acceptable.
    const priorManifest = readRegular(manifestPath, manifestCap);
    const priorBundle = regularExists(bundlePath, bundleCap);
    if (priorManifest !== null) {
      let prior: Manifest;
      try {
        prior = parseManifest(priorManifest);
      } catch {
        throw new HandoffError("output_conflict", `${manifestPath} exists and is not a valid manifest`);
      }
      if (!sameManifest(prior, { ...want, sha256: prior.sha256 })) {
        throw new HandoffError("output_conflict", `${id} was already exported as attempt ${prior.attempt_id}, head ${prior.head_sha}`);
      }
      if (!priorBundle) throw new HandoffError("output_conflict", `${manifestPath} exists without its bundle`);
      const have = sha256File(bundlePath, bundleCap);
      if (have.sha256 !== prior.sha256) throw new HandoffError("output_conflict", `${bundlePath} does not match its manifest`);
      checkBundle(input, bundlePath);
      return describe(have.sha256, have.bytes, true);
    }
    if (priorBundle) throw new HandoffError("output_partial", `${bundlePath} exists without a manifest; an earlier export was interrupted`);

    // 1. The bundle, under a temporary name, flushed and verified.
    // Created here, exclusively and without following a link: from this line the file is this call's.
    const bundleFd = fs.openSync(tmpBundle, O_CREATE, 0o644);
    const made = fs.fstatSync(bundleFd);
    const tmp: Owned = { dev: made.dev, ino: made.ino, sha256: null };
    tmpBundleMade = tmp;
    await writeBundle(input, bundleFd, bundleCap);
    const first = sha256File(tmpBundle, bundleCap);
    tmp.sha256 = first.sha256;
    checkBundle(input, tmpBundle);
    // The branch must not have moved while the bundle was written.
    const still = git(input.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}^{commit}`);
    if (still.out.trim() !== input.headSha) throw new HandoffError("branch_mismatch", `${input.branch} moved during the export`);

    // 2. Publish the bundle without overwriting anything, then flush the directory.
    fs.linkSync(tmpBundle, bundlePath);
    // A hard link shares the inode: the identity taken at creation is this bundle's, whatever the name holds later.
    bundleLinked = { ...tmp, sha256: first.sha256 };
    fs.unlinkSync(tmpBundle);
    tmpBundleMade = null;
    fsyncDir(root);
    opts.hooks?.afterBundleLink?.();

    // 3. The manifest, built from the bytes that are now in place.
    const manifest: Manifest = { ...want, sha256: first.sha256 };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (bytes.length > manifestCap) throw new HandoffError("too_large", `the manifest is ${bytes.length} bytes, over the ${manifestCap} byte limit`);
    parseManifest(bytes); // exactly the publisher's reader
    writeNew(tmpManifest, bytes, (owned) => {
      tmpManifestMade = { ...owned, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    });
    opts.hooks?.beforeManifestLink?.();

    // The marker goes up only while the bundle in place is still the one that was hashed.
    const again = sha256File(bundlePath, bundleCap);
    const now = fs.lstatSync(bundlePath);
    if (again.sha256 !== first.sha256 || now.ino !== bundleLinked.ino || now.dev !== bundleLinked.dev) {
      throw new HandoffError("output_conflict", `${bundlePath} changed while it was being exported`);
    }
    fs.linkSync(tmpManifest, manifestPath);
    fs.unlinkSync(tmpManifest);
    tmpManifestMade = null;
    fsyncDir(root);
    return describe(first.sha256, first.bytes, false);
  } catch (err) {
    if (err instanceof SimulatedCrash) {
      crashed = true;
      throw err;
    }
    // Remove only what this call made, and only while it is still that file: a replacement under
    // the same name stays. A manifest that never appeared leaves no export, so the bundle this call
    // linked goes too, unless the name now holds something else.
    if (tmpManifestMade && isOwned(tmpManifest, tmpManifestMade, manifestCap, stat)) fs.rmSync(tmpManifest, { force: true });
    if (tmpBundleMade && isOwned(tmpBundle, tmpBundleMade, bundleCap, stat)) fs.rmSync(tmpBundle, { force: true });
    if (bundleLinked && !fs.existsSync(manifestPath) && isOwned(bundlePath, bundleLinked, bundleCap, stat)) {
      try {
        fs.unlinkSync(bundlePath);
      } catch {
        // already gone
      }
    }
    if (err instanceof HandoffError) throw err;
    throw new HandoffError("output_unsafe", (err as Error).message);
  } finally {
    if (!crashed) release(lockPath, token);
  }
}

/** Remove the reservation only if it is still this call's. */
function release(lockPath: string, token: string): void {
  try {
    const held = readRegular(lockPath, 4096);
    if (held !== null && held.toString("utf8").split("\n")[0] === token) fs.unlinkSync(lockPath);
  } catch {
    // not ours, or unreadable: leave it
  }
}

// ── command line ───────────────────────────────────────────────────────────────────────────

const USAGE = `usage: bun src/handoff.ts export --repo-path P --handoff-root D --task-id T --attempt-id A \\
         --repo OWNER/NAME --base-sha SHA --head-sha SHA --branch B
Prints the export as JSON. Exit: 0 exported, 1 usage, 3 refused, 2 unreadable.`;

export async function main(argv: string[]): Promise<number> {
  const print = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v)}\n`);
  const [cmd, ...rest] = argv;
  if (cmd !== "export") {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const flags: Record<string, string> = {};
  const names = ["--repo-path", "--handoff-root", "--task-id", "--attempt-id", "--repo", "--base-sha", "--head-sha", "--branch"];
  for (let n = 0; n < rest.length; n += 2) {
    const k = rest[n]!;
    const v = rest[n + 1];
    if (!names.includes(k) || v === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    flags[k] = v;
  }
  if (names.some((k) => !flags[k])) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  try {
    print(await exportHandoff({
      repoPath: flags["--repo-path"]!, handoffRoot: flags["--handoff-root"]!, taskId: flags["--task-id"]!, attemptId: flags["--attempt-id"]!,
      repo: flags["--repo"]!, baseSha: flags["--base-sha"]!, headSha: flags["--head-sha"]!, branch: flags["--branch"]!,
    }));
    return 0;
  } catch (err) {
    if (err instanceof HandoffError) return print({ ok: false, code: err.code, detail: err.message }), err.code === "source_unreadable" ? 2 : 3;
    return print({ ok: false, code: "unreadable", detail: (err as Error).message }), 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
