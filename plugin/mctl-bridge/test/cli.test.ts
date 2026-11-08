// The CLI as the orchestrator runs it: a separate process per command.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bridge, newId } from "../src/store.ts";
import type { Result } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let server: ValkeyServer;

function cli(args: string[], input?: string): { code: number; out: any } {
  const r = spawnSync(process.execPath, ["run", "--silent", "--no-env-file", CLI, ...args], {
    env: { ...process.env, MCTL_BRIDGE_VALKEY_URL: server.url },
    input,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: JSON.parse(r.stdout.trim().split("\n").at(-1)!) };
}

function must(r: Result): Record<string, any> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Record<string, any>;
}

describe.skipIf(requiresValkey)("mctl-bridge CLI", () => {
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  test("a question goes from wait to claim to reply, and a refusal exits 1", async () => {
    expect(cli(["init"])).toMatchObject({ code: 0, out: { ok: true, durability: { status: "weak" } } });
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "a", uuid: "u", conn_id: "k", pid: 1, pid_start: "s", cwd: "/w" }));
    const c = { slot: "a", conn_id: "k", epoch: reg.epoch };
    must(await b.heartbeat(c, false));

    const sent = cli(["send", "--slot", "a", "--text", "-"], "fix the build");
    expect(sent.code).toBe(0);
    const next = must(await b.next(c));
    expect(next.payload).toBe("fix the build");
    must(await b.emitted(c, next.id));
    const ack = must(await b.ackTask(c, next.id, next.attempt_id));
    const q = must(await b.ask("a", ack.admission, "which branch?"));

    const waited = cli(["wait", "--timeout", "1"]);
    expect(waited.out.questions.map((x: any) => x.id)).toEqual([q.question_id]);
    expect(waited.out.events.map((e: any) => e.event)).toContain("asked");
    // the cursor moved: the same events are not returned twice
    expect(cli(["wait", "--timeout", "0"]).out.events).toEqual([]);

    const claim = cli(["claim", q.question_id]);
    expect(claim.code).toBe(0);
    expect(cli(["claim", q.question_id])).toMatchObject({ code: 1, out: { ok: false, code: "claimed" } });
    expect(cli(["wait", "--timeout", "0"]).out.questions).toEqual([]);
    expect(cli(["reply", q.question_id, "--token", claim.out.claim_token, "--text", "main"]).code).toBe(0);
    expect(cli(["status", q.question_id]).out.message.state).toBe("reply_committed");
  });

  test("errors lists delivery_unknown with its reason and late evidence", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "e", uuid: "u", conn_id: "k1", pid: 7, pid_start: "s", cwd: "/w" }));
    const c = { slot: "e", conn_id: "k1", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const sent = must(await b.send({ slot: "e", payload: "x" }));
    const next = must(await b.next(c));
    must(await b.emitted(c, sent.id));
    const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
    must(await b.register({ slot: "e", uuid: "u2", conn_id: newId("k"), pid: 7, pid_start: "s", cwd: "/w" }));
    await b.result("e", ack.admission, "completed", "done anyway");
    const errors = cli(["errors"]).out;
    expect(errors.unknown.find((m: any) => m.id === sent.id)).toMatchObject({ state: "delivery_unknown", reason: "epoch_changed" });
    expect(errors.late[sent.id][0]).toMatchObject({ kind: "result", reason: "fenced", payload: "done anyway" });
    expect(cli(["resolve", sent.id, "--as", "completed", "--reason", "late result shows it ran", "--author", "op"]).code).toBe(0);
    expect(cli(["status", sent.id]).out.message.state).toBe("completed");
  });

  test("a wake_unknown shows in errors and wakes, and resolve closes it", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "w", uuid: "u", conn_id: "kw", pid: 9, pid_start: "s", cwd: "/w" }));
    const c = { slot: "w", conn_id: "kw", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const sent = must(await b.send({ slot: "w", payload: "x" }));
    const next = must(await b.next(c));
    must(await b.emitted(c, sent.id));
    const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
    const q = must(await b.ask("w", ack.admission, "which?"));
    const wake = must(await b.wakeBegin({ question_id: q.question_id, thread_id: "thread-cli", lock_ms: 60_000, per_hour: 10, quiet_ms: 0 }));
    must(await b.wakeFinish(wake.wake_id, "wake_unknown", "history_matches_0"));
    expect(cli(["errors"]).out.wakes.find((w: any) => w.id === wake.wake_id)).toMatchObject({ state: "wake_unknown", reason: "history_matches_0" });
    expect(cli(["wakes"]).out.wakes.map((w: any) => w.id)).toContain(wake.wake_id);
    expect(cli(["resolve", wake.wake_id, "--author", "op"]).code).toBe(2); // a reason is required
    expect(cli(["resolve", wake.wake_id, "--reason", "no turn in the thread", "--author", "op"]).code).toBe(0);
    expect(cli(["wakes"]).out.wakes.map((w: any) => w.id)).not.toContain(wake.wake_id);
  });

  test("free text from stdin or a file arrives byte-exact, with no shell in between", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "t", uuid: "u", conn_id: "kt", pid: 11, pid_start: "s", cwd: "/w" }));
    const c = { slot: "t", conn_id: "kt", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-text-"));
    const marker = path.join(dir, "SHOULD_NOT_EXIST");
    const bodies = [
      `it's "quoted" $(touch ${marker}) \`touch ${marker}\` back\\slash \\n \${"$"}HOME`,
      "line one\n\n  indented line\r\nline three\ttabbed\n\nlast",
      "--looks-like-a-flag and -x",
      "unicode: \u00e9\u4e2d\ud83d\ude00",
    ];
    let n = 0;
    for (const body of bodies) {
      for (const via of ["stdin", "file"]) {
        const sent = must(await b.send({ slot: "t", payload: `task ${n++}` }));
        const next = must(await b.next(c));
        must(await b.emitted(c, sent.id));
        const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
        const q = must(await b.ask("t", ack.admission, "which?"));
        const claim = cli(["claim", q.question_id]);
        // a here-document ends the text with exactly one newline: it is dropped, nothing else is
        let r;
        if (via === "stdin") {
          r = cli(["reply", q.question_id, "--token", claim.out.claim_token, "--stdin"], body + "\n");
        } else {
          const f = path.join(dir, `body-${n}`);
          fs.writeFileSync(f, body + "\n");
          r = cli(["reply", q.question_id, "--token", claim.out.claim_token, "--file", f]);
        }
        expect(r.code).toBe(0);
        // the text the slot is handed is the text that was typed
        const got = must(await b.next(c));
        expect(got).toMatchObject({ kind: "reply", id: q.question_id });
        expect(got.payload).toBe(body);
        must(await b.emitted(c, q.question_id));
        must(await b.ackReply(c, q.question_id, got.reply_id));
        must(await b.result("t", ack.admission, "completed", "ok"));
      }
    }
    expect(fs.existsSync(marker)).toBe(false);
    // only the one trailing newline is dropped: a second one survives
    const sent = must(await b.send({ slot: "t", payload: "x" }));
    const next = must(await b.next(c));
    must(await b.emitted(c, sent.id));
    const ack = must(await b.ackTask(c, sent.id, next.attempt_id));
    const q = must(await b.ask("t", ack.admission, "again?"));
    const claim = cli(["claim", q.question_id]);
    cli(["reply", q.question_id, "--token", claim.out.claim_token, "--stdin"], "a\n\n");
    expect(must(await b.next(c)).payload).toBe("a\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("send takes its payload from stdin or a file, and resolve its reason", async () => {
    const b = new Bridge(server.client());
    must(await b.register({ slot: "t2", uuid: "u", conn_id: "k2", pid: 12, pid_start: "s", cwd: "/w" }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-text-"));
    const body = `it's "x" $(touch ${dir}/NOPE)\nsecond line`;
    const sent = cli(["send", "--slot", "t2", "--stdin"], body + "\n");
    expect(sent.code).toBe(0);
    expect(Object.values(cli(["status", sent.out.id]).out.message)).toContain(body);
    fs.writeFileSync(path.join(dir, "p"), body);
    const sent2 = cli(["send", "--slot", "t2", "--file", path.join(dir, "p")]);
    expect(Object.values(cli(["status", sent2.out.id]).out.message)).toContain(body);
    const why = `it's "late" \`ok\`\nbecause`;
    expect(cli(["resolve", sent.out.id, "--as", "cancelled", "--stdin", "--author", "op"], why + "\n").code).toBe(0);
    expect(JSON.stringify(cli(["status", sent.out.id]).out.audit)).toContain(JSON.stringify(why).slice(1, -1));
    expect(fs.existsSync(path.join(dir, "NOPE"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("zero or several text sources, or an unreadable file, exit 2", () => {
    const args = ["reply", "q-1", "--token", "c-1"];
    expect(cli(args).code).toBe(2);
    expect(cli([...args, "--text", "a", "--stdin"], "b").code).toBe(2);
    expect(cli([...args, "--text", "a", "--file", "/etc/hosts"]).code).toBe(2);
    expect(cli([...args, "--stdin", "--file", "/etc/hosts"], "b").code).toBe(2);
    expect(cli([...args, "--file", "/nonexistent/file"]).code).toBe(2);
    expect(cli(["send", "--slot", "t2", "--text", "a", "--stdin"], "b").code).toBe(2);
    expect(cli(["resolve", "t-1", "--as", "failed", "--reason", "a", "--stdin"], "b").code).toBe(2);
    expect(cli(["resolve", "t-1", "--as", "failed", "--author", "op"]).code).toBe(2);
  });

  test("steer sends a note from a file to the in-flight task, and Codex may run it without a prompt", async () => {
    const b = new Bridge(server.client());
    const reg = must(await b.register({ slot: "s", uuid: "u2", conn_id: "k2", pid: 2, pid_start: "s", cwd: "/w" }));
    const c = { slot: "s", conn_id: "k2", epoch: reg.epoch };
    must(await b.heartbeat(c, false));
    const sent = cli(["send", "--slot", "s", "--text", "run the tests"]);
    expect(cli(["steer", sent.out.id, "--text", "x"])).toMatchObject({ code: 1, out: { ok: false, code: "not_acked" } });
    const next = must(await b.next(c));
    must(await b.emitted(c, next.id));
    must(await b.ackTask(c, next.id, next.attempt_id));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steer-"));
    const note = "Your `golangci-lint run --fix` was refused: run it without --fix.\n";
    fs.writeFileSync(path.join(dir, "note.txt"), note);
    const st = cli(["steer", next.id, "--file", path.join(dir, "note.txt")]);
    expect(st).toMatchObject({ code: 0, out: { ok: true, task_id: next.id } });
    const got = must(await b.next(c));
    expect(got).toMatchObject({ kind: "reply", task_id: next.id, payload: note.slice(0, -1) });
    expect(cli(["steer"]).code).toBe(2);
    fs.rmSync(dir, { recursive: true });

    const rules = fs.readFileSync(path.join(path.dirname(CLI), "..", "ops", "codex-mctl-bridge.rules"), "utf8");
    const allowed = rules.match(/pattern = \["mctl-bridge", \[([^\]]*)\]\]/)![1]!;
    expect(allowed.split(",").map((x) => x.trim().replace(/"/g, ""))).toContain("steer");
  });

  test("usage errors exit 2", () => {
    expect(cli(["send"]).code).toBe(2);
    expect(cli(["nope"]).code).toBe(2);
  });
});
