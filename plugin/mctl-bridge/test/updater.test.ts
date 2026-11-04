// ops/bridge-updater.sh deploys the release the repository declares. Real git against a
// local fixture repository; install.sh is a recording stub inside each tagged tree.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops");
const usable = ["git", "zsh", "tar"].every((b) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0);
const w = (msg: string) => JSON.stringify({ msg });
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// Each commit carries a stub install.sh that records its own marker, thread id and env.
function commit(repo: string, marker: string, opts: { failInstall?: boolean } = {}) {
  const dir = path.join(repo, "plugin", "mctl-bridge", "ops");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "install.sh"),
    `#!/bin/zsh\nprint -r -- "${marker} thread=$1 home=$MCTL_BRIDGE_HOME ver=$MCTL_BRIDGE_VERSION fromupd=$MCTL_BRIDGE_FROM_UPDATER" >> "$MCTL_BRIDGE_HOME/installs"\n${opts.failInstall ? "exit 3" : "exit 0"}\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", marker);
  return git(repo, "rev-parse", "HEAD");
}

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "upd-")));
  const repo = path.join(root, "repo");
  const H = path.join(root, "home");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const d of ["etc", "log"]) fs.mkdirSync(path.join(H, d), { recursive: true });
  fs.copyFileSync(path.join(OPS, "bridge-updater.sh"), path.join(H, "bridge-updater.sh"));
  fs.copyFileSync(path.join(OPS, "wake-state.sh"), path.join(H, "wake-state.sh"));
  fs.writeFileSync(path.join(H, "etc", "thread-id"), "thread-1\n");
  fs.writeFileSync(path.join(H, "log", "waker.log"), w("started") + "\n");
  const run = () => {
    const r = spawnSync("sh", [path.join(H, "bridge-updater.sh")], { encoding: "utf8", env: { ...process.env, ...GIT_ENV, MCTL_BRIDGE_HOME: H, MCTL_UPDATER_REPO: repo, TMPDIR: root } });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const installs = () => (fs.existsSync(path.join(H, "installs")) ? fs.readFileSync(path.join(H, "installs"), "utf8").trim().split("\n") : []);
  const version = () => (fs.existsSync(path.join(H, "VERSION")) ? fs.readFileSync(path.join(H, "VERSION"), "utf8").trim() : null);
  return { root, repo, H, run, installs, version };
}

describe.skipIf(!usable)("bridge-updater", () => {
  test("installs the highest release tag on main, with thread id, home and version", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "0.9.0");
    commit(t.repo, "b"); git(t.repo, "tag", "0.10.0"); // numeric, not lexical: 0.10.0 > 0.9.0
    const sha = git(t.repo, "rev-parse", "HEAD");
    const r = t.run();
    expect(r.status).toBe(0);
    expect(t.installs()).toEqual([`b thread=thread-1 home=${t.H} ver=0.10.0 ${sha} fromupd=1`]);
  });

  test("an unchanged release is not installed again", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    const sha = git(t.repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(t.H, "VERSION"), `1.0.0 ${sha}\n`);
    expect(t.run().status).toBe(0);
    expect(t.installs()).toEqual([]);
  });

  test("a moved tag with the same name is a new release", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    fs.writeFileSync(path.join(t.H, "VERSION"), `1.0.0 ${"0".repeat(40)}\n`);
    t.run();
    expect(t.installs().length).toBe(1);
  });

  test("non-release tags are ignored", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    commit(t.repo, "b");
    for (const bad of ["v2.0.0", "2.0.0-rc1", "2.0", "2.0.0.1", "latest"]) git(t.repo, "tag", bad);
    t.run();
    expect(t.installs()).toHaveLength(1);
    expect(t.installs()[0]).toContain("a thread");
  });

  test("a tag on a commit that is not on main never deploys", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    git(t.repo, "checkout", "-q", "-b", "side");
    commit(t.repo, "evil"); git(t.repo, "tag", "9.9.9");
    git(t.repo, "checkout", "-q", "main");
    t.run();
    expect(t.installs()).toHaveLength(1);
    expect(t.installs()[0]).toContain("a thread");
  });

  test("a pin holds an older release and can roll back", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    commit(t.repo, "b"); git(t.repo, "tag", "1.1.0");
    fs.writeFileSync(path.join(t.H, "etc", "pin"), "1.0.0\n");
    t.run();
    expect(t.installs()).toHaveLength(1);
    expect(t.installs()[0]).toContain("a thread");
    expect(t.version()).toBeNull(); // the stub does not write it; install.sh does
  });

  test("a pin to a tag that is not on main is refused", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    git(t.repo, "checkout", "-q", "-b", "side");
    commit(t.repo, "evil"); git(t.repo, "tag", "9.9.9");
    git(t.repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(t.H, "etc", "pin"), "9.9.9\n");
    const r = t.run();
    expect(r.status).toBe(1);
    expect(t.installs()).toEqual([]);
  });

  test("a failed fetch is unknown, not up to date: nothing is installed and the run fails", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    fs.rmSync(path.join(t.repo, ".git"), { recursive: true });
    const r = t.run();
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not fetch");
    expect(t.installs()).toEqual([]);
  });

  test("a wake in flight defers the update; an unreadable log does too", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    fs.writeFileSync(path.join(t.H, "log", "waker.log"), [w("started"), w("wake intent"), w("wake started")].join("\n") + "\n");
    expect(t.run().out).toContain("wake is in flight");
    fs.rmSync(path.join(t.H, "log", "waker.log"));
    expect(t.run().out).toContain("unreadable");
    expect(t.installs()).toEqual([]);
    fs.writeFileSync(path.join(t.H, "log", "waker.log"), [w("wake intent"), w("wake started"), w("wake completed")].join("\n") + "\n");
    t.run();
    expect(t.installs()).toHaveLength(1);
  });

  test("without a thread id nothing is installed", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    fs.rmSync(path.join(t.H, "etc", "thread-id"));
    const r = t.run();
    expect(r.status).toBe(0);
    expect(r.out).toContain("thread-id");
    expect(t.installs()).toEqual([]);
  });

  test("a failed install is not retried for the same release, but a newer one is tried", () => {
    const t = setup();
    commit(t.repo, "bad", { failInstall: true }); git(t.repo, "tag", "1.0.0");
    expect(t.run().status).toBe(1);
    expect(t.run().status).toBe(0); // skipped, not retried
    expect(t.installs()).toHaveLength(1);
    expect(fs.existsSync(path.join(t.H, "etc", "updater-failed"))).toBe(true);
    commit(t.repo, "fixed"); git(t.repo, "tag", "1.0.1");
    expect(t.run().status).toBe(0);
    expect(t.installs()).toHaveLength(2);
    expect(fs.existsSync(path.join(t.H, "etc", "updater-failed"))).toBe(false);
  });

  test("a live lock holder blocks a second run; a stale lock does not", () => {
    const t = setup();
    commit(t.repo, "a"); git(t.repo, "tag", "1.0.0");
    const lock = path.join(t.H, "run", "updater.lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    expect(t.run().out).toContain("another run");
    expect(t.installs()).toEqual([]);
    fs.writeFileSync(path.join(lock, "pid"), "2147483646");
    t.run();
    expect(t.installs()).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false); // released
  });

  // install.sh needs Valkey and launchd, so its updater-related guarantees are checked on
  // the script text; the mutations in mutate.py prove each of these lines matters.
  test("install.sh: never boots out the updater job from inside the updater, swaps scripts by rename, records thread and version", () => {
    const src = fs.readFileSync(path.join(OPS, "install.sh"), "utf8");
    expect(src).toContain("if [[ -z ${MCTL_BRIDGE_FROM_UPDATER:-} ]]; then\n  launchctl bootout gui/$UID_/$upd");
    expect(src).toContain("mv -f $H/$f.new $H/$f");
    expect(src).toContain('print -r -- "$THREAD_ID" > $H/etc/thread-id');
    expect(src).toContain('print -r -- "${MCTL_BRIDGE_VERSION:-manual}" > $H/VERSION');
    for (const f of ["codex-remote-guard.sh", "bridge-updater.sh", "wake-state.sh"]) expect(src).toContain(f);
  });
});
