// The channel's export_handoff tool: the slot exports its own branch for mctl-publish, with
// the attempt taken from its admission and the directory from the launcher, never from the model.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Adapter, repoFromRemote } from "../src/channel.ts";
import type { Config } from "../src/channel.ts";
import { parseManifest } from "../src/publish.ts";
import { Bridge } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

let server: ValkeyServer;
let tmp: string;

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
}

/** A checkout on a feature branch one commit past origin/main, plus an adapter holding a task for it. */
async function setup(o: { handoffRoot?: string } = {}) {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", "https://github.com/mctlhq/example.git");
  git(repo, "update-ref", "refs/remotes/origin/main", base);
  git(repo, "checkout", "-q", "-b", "feat/x");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add a");
  const head = git(repo, "rev-parse", "HEAD");
  const root = path.join(tmp, "handoff");
  fs.mkdirSync(root, { mode: 0o700 });
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(stateDir);
  const cfg: Config = {
    slot: "h", stateDir, claudePid: process.pid, pollMs: 10, heartbeatMs: 10_000, graceMs: 0, emitHoldMs: 0,
    initialSessionId: crypto.randomUUID(), cwd: repo, handoffRoot: o.handoffRoot ?? root,
  };
  fs.writeFileSync(path.join(stateDir, `${process.pid}.json`), JSON.stringify({ session_id: cfg.initialSessionId, state: "idle", t: Date.now() / 1000 + 60 }));
  const b = new Bridge(server.client());
  const events: any[] = [];
  const adapter = new Adapter(b, cfg, async (m) => void events.push(m));
  await adapter.tick(); // registers
  const sent = await b.send({ slot: "h", payload: "add a" });
  await adapter.tick(); // emits
  const meta = events.at(-1)!.params.meta;
  return { repo, root, base, head, b, adapter, taskId: String((sent as any).id), attemptId: String(meta.attempt_id) };
}

describe.skipIf(requiresValkey)("export_handoff", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    await server.client().execute(["FLUSHALL"]);
    await (await server.bridge()).checkVersion();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "export-handoff-")));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("exports the admitted attempt from merge base to HEAD into the launcher's directory", async () => {
    const s = await setup();
    // no admission yet: nothing is exported
    await expect(s.adapter.call("export_handoff", { task_id: s.taskId })).rejects.toThrow(/ack_task first/);
    expect(fs.readdirSync(s.root)).toEqual([]);
    expect((await s.adapter.call("ack_task", { task_id: s.taskId, attempt_id: s.attemptId })).ok).toBe(true);
    const r = (await s.adapter.call("export_handoff", { task_id: s.taskId, attempt_id: "a-forged", handoff_root: "/tmp" })) as Record<string, any>;
    expect(r).toMatchObject({ ok: true, task_id: s.taskId, attempt_id: s.attemptId, repo: "mctlhq/example", base_sha: s.base, head_sha: s.head, branch: "feat/x", changed_files: ["a.txt"] });
    expect(path.dirname(r.bundle_path)).toBe(s.root);
    const m = parseManifest(fs.readFileSync(r.manifest_path));
    expect(m).toMatchObject({ task_id: s.taskId, attempt_id: s.attemptId, head_sha: s.head, base_sha: s.base });
  });

  test("a dirty work tree is refused with the exporter's code, and no root means no export", async () => {
    const s = await setup();
    await s.adapter.call("ack_task", { task_id: s.taskId, attempt_id: s.attemptId });
    fs.writeFileSync(path.join(s.repo, "a.txt"), "uncommitted\n");
    expect(await s.adapter.call("export_handoff", { task_id: s.taskId })).toMatchObject({ ok: false, code: "source_dirty" });
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "export-handoff-")));
    await server.client().execute(["FLUSHALL"]);
    const t = await setup({ handoffRoot: "" });
    await t.adapter.call("ack_task", { task_id: t.taskId, attempt_id: t.attemptId });
    await expect(t.adapter.call("export_handoff", { task_id: t.taskId })).rejects.toThrow(/no handoff directory/);
  });

  test("a detached HEAD is refused with a message the slot can act on", async () => {
    const s = await setup();
    await s.adapter.call("ack_task", { task_id: s.taskId, attempt_id: s.attemptId });
    execFileSync("git", ["checkout", "-q", "--detach"], { cwd: s.repo });
    await expect(s.adapter.call("export_handoff", { task_id: s.taskId })).rejects.toThrow(/HEAD is detached/);
    expect(fs.readdirSync(s.root)).toEqual([]);
  });

  test("the repository comes only from a github.com origin", () => {
    expect(repoFromRemote("https://github.com/mctlhq/mctl-api.git")).toBe("mctlhq/mctl-api");
    expect(repoFromRemote("git@github.com:mctlhq/mctl-api.git")).toBe("mctlhq/mctl-api");
    expect(repoFromRemote("https://github.com/mctlhq/mctl-api")).toBe("mctlhq/mctl-api");
    expect(repoFromRemote("https://github.com.evil/mctlhq/x.git")).toBeNull();
    expect(repoFromRemote("https://github.com/mctlhq/x/../y")).toBeNull();
    expect(repoFromRemote("/Users/op/mctl-api")).toBeNull();
  });
});
