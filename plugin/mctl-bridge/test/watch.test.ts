// The operator's view of a task, question or wake: `mctl-bridge observe` and ops/watch.sh.
// The pilot's monitor printed an empty state (and "closed") when its own parsing broke, which
// looked like a task that had left the open set. Here a reading that cannot be trusted is
// always an error, never a state.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bridge } from "../src/store.ts";
import type { Result } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli.ts");
const WATCH = path.join(HERE, "..", "ops", "watch.sh");
let server: ValkeyServer;
let tmp: string;

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Record<string, any>;
}

function cli(...args: string[]): { code: number; out: any } {
  const r = spawnSync(process.execPath, ["run", "--silent", "--no-env-file", CLI, ...args], {
    env: { ...process.env, MCTL_BRIDGE_VALKEY_URL: server.url },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: JSON.parse(r.stdout.trim().split("\n").at(-1)!) };
}
const observe = (id: string) => cli("observe", id);

// A stand-in CLI: prints exactly what the test hands it, so the watcher's reading of bad output is tested.
function fakeCli(name: string, body: string): string {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}

function watch(cli: string, id: string, max = "0"): { code: number; stdout: string } {
  const r = spawnSync("/bin/sh", [WATCH, id, "1", max], { env: { ...process.env, MCTL_BRIDGE_CLI: cli }, encoding: "utf8", timeout: 30000 });
  return { code: r.status ?? -1, stdout: r.stdout };
}

describe.skipIf(requiresValkey)("observe and watch", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
    expect(cli("init").code).toBe(0);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watch-"));
  });
  afterAll(async () => {
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("observe follows a task and a question to their end, and names the adapter's liveness for what it is", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "a", uuid: "u", conn_id: "k", pid: 1, pid_start: "s", cwd: "/w" }));
    const c = { slot: "a", conn_id: "k", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const sent = must(await b.send({ slot: "a", payload: "x" }));
    expect(observe(sent.id).out).toMatchObject({ ok: true, kind: "task", state: "queued", terminal: false, needs_operator: false });

    const next = must(await b.next(c));
    must(await b.emitted(c, next.id));
    const ack = must(await b.ackTask(c, next.id, next.attempt_id));
    const q = must(await b.ask("a", ack.admission, "which branch?"));
    must(await b.heartbeat(c, true)); // the hook marks the session busy
    const task = observe(sent.id).out;
    expect(task).toMatchObject({ state: "acked", terminal: false });
    expect(task.slot).toMatchObject({ slot: "a", registered: true, busy: true });
    expect(task.slot.note).toContain("not evidence of progress");
    expect(observe(q.question_id).out).toMatchObject({ kind: "question", state: "asked", terminal: false, wakes: [] });

    must(await b.result("a", ack.admission, "completed", "done"));
    expect(observe(sent.id).out).toMatchObject({ state: "completed", terminal: true });
  });

  test("an unknown id is refused, not reported as settled or empty", () => {
    const r = observe("t-" + "0".repeat(8));
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, code: "unknown" });
    expect(r.out.state).toBeUndefined();
  });

  test("watch exits 0 on a settled state and prints it once", () => {
    const cli = fakeCli("done", `echo '{"ok":true,"id":"t-1","kind":"task","state":"completed","reason":"","terminal":true,"needs_operator":false}'`);
    const r = watch(cli, "t-1");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("task t-1 completed\n");
  });

  test("watch stops with 4 when a state needs the operator", () => {
    const cli = fakeCli("unk", `echo '{"ok":true,"id":"t-1","kind":"task","state":"delivery_unknown","reason":"conn lost","terminal":false,"needs_operator":true}'`);
    const r = watch(cli, "t-1");
    expect(r.code).toBe(4);
    expect(r.stdout).toContain("WATCH-NEEDS-OPERATOR");
  });

  test("empty output (the pilot's failure) is an error, never a state, and ends the watch with 3", () => {
    const r = watch(fakeCli("empty", "exit 0"), "t-1", "30");
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("WATCH-ERROR: empty output");
    expect(r.stdout).not.toMatch(/completed|closed|settled/);
  }, 20000);

  test("garbled output and a refusal are errors that say why", () => {
    const garbled = watch(fakeCli("garbled", "echo 'Traceback (most recent call last)'"), "t-1", "30");
    expect(garbled.code).toBe(3);
    expect(garbled.stdout).toContain("WATCH-ERROR: unreadable output: Traceback");
    const unknown = watch(fakeCli("refused", `echo '{"ok":false,"code":"unknown","id":"t-1"}'; exit 1`), "t-1", "30");
    expect(unknown.code).toBe(3);
    expect(unknown.stdout).toContain("cli refused: unknown");
  }, 20000);

  test("a hung reading ends as a printed error, never as silence", () => {
    const hung = fakeCli("hung", "sleep 30");
    const r = spawnSync("/bin/sh", [WATCH, "t-1", "1", "60"], {
      env: { ...process.env, MCTL_BRIDGE_CLI: hung, MCTL_BRIDGE_READING_TIMEOUT: "1" },
      encoding: "utf8",
      timeout: 40000,
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("WATCH-ERROR: no answer within 1s");
  }, 30000);

  test("text with backslashes is printed as it is", () => {
    const cli = fakeCli("bs", `cat <<'EOF'\n{"ok":true,"id":"t-1","kind":"task","state":"completed","reason":"a\\\\nb\\\\c","terminal":true,"needs_operator":false}\nEOF`);
    expect(watch(cli, "t-1").stdout).toBe("task t-1 completed reason=a\\nb\\c\n");
  });

  test("a reading with no state is an error, not a blank state", () => {
    const r = watch(fakeCli("nostate", `echo '{"ok":true,"id":"t-1"}'`), "t-1", "30");
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("carries no state");
  }, 20000);

  test("a task that has not settled by the deadline ends with 5 and says where it stood", () => {
    const cli = fakeCli("run", `echo '{"ok":true,"id":"t-1","kind":"task","state":"acked","reason":"","terminal":false,"needs_operator":false}'`);
    const r = watch(cli, "t-1", "1");
    expect(r.code).toBe(5);
    expect(r.stdout).toContain("WATCH-TIMEOUT");
    expect(r.stdout).toContain("task t-1 acked");
  });

  test("open wakes of a question are shown next to its state", () => {
    const cli = fakeCli("wk", `echo '{"ok":true,"id":"q-1","kind":"question","state":"asked","reason":"","terminal":false,"needs_operator":false,"wakes":[{"id":"w-9","state":"started"}]}'`);
    const r = watch(cli, "q-1", "0");
    expect(r.stdout).toContain("question q-1 asked wake w-9=started");
  });
});
