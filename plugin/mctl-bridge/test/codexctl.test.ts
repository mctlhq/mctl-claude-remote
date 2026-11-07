// mctl-codex against a fake Codex app server on a Unix socket.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BRIDGE_PREFIX, CodexThread, LEAD_PREFIX, QUESTION_MARKER, redact } from "../src/codexctl.ts";
import type { Config } from "../src/codexctl.ts";
import { FakeApp } from "./fakeapp.ts";

const CLI = path.join(import.meta.dir, "..", "src", "codexctl.ts");

let app: FakeApp;
let dir: string;
let cfg: Config;
let thread: CodexThread;

beforeEach(() => {
  app = new FakeApp().start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexctl-"));
  cfg = { threadId: app.threadId, socketPath: app.path, sendLog: path.join(dir, "sends.jsonl"), rpcTimeoutMs: 500 };
  thread = new CodexThread(cfg);
});

afterEach(() => {
  app.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sends = (): any[] =>
  fs.existsSync(cfg.sendLog) ? fs.readFileSync(cfg.sendLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

async function cli(args: string[], stdin = ""): Promise<{ code: number; out: any; err: string }> {
  const p = Bun.spawn(["bun", "run", "--no-env-file", CLI, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MCTL_BRIDGE_THREAD_ID: cfg.threadId, MCTL_BRIDGE_CODEX_SOCKET: cfg.socketPath, MCTL_CODEX_SEND_LOG: cfg.sendLog, MCTL_CODEX_RPC_TIMEOUT_MS: "500" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim() ? JSON.parse(out) : null, err };
}

describe("redact", () => {
  const secrets: Array<[string, string]> = [
    ["github classic", "ghp_abcdefghijklmnopqrstuvwxyz012345"],
    ["github server", "ghs_abcdefghijklmnopqrstuvwxyz012345"],
    ["github fine grained", "github_pat_abcdefghijklmnopqrstuvwxyz_012345"],
    ["api key", "sk-ant-abcdefghijklmnopqrstuvwxyz012345"],
    ["slack", "xoxb-123456789012-abcdefghijkl"],
    ["aws", "AKIAABCDEFGHIJKLMNOP"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl"],
    ["telegram", "123456789:AAabcdefghijklmnopqrstuvwxyz0123456"],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----"],
    ["cut private key", "-----BEGIN RSA PRIVATE KEY-----\nabcdef"],
  ];
  for (const [name, s] of secrets) {
    test(`hides a ${name}`, () => {
      const out = redact(`before ${s} after`);
      expect(out).not.toContain(s.split("\n").at(-1) === "abcdef" ? "abcdef" : s);
      expect(out).toContain("before");
      expect(out).toContain("[REDACTED");
    });
  }
  test("hides values, not names", () => {
    expect(redact("password=hunter2 api_key: abc123 VALKEY_TOKEN=\"xyz\"")).toBe('password=[REDACTED] api_key: [REDACTED] VALKEY_TOKEN="[REDACTED]"');
    expect(redact("Authorization: Bearer abcdef123456")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("redis://bridge_orch:s3cret@127.0.0.1:6390/0")).toBe("redis://bridge_orch:[REDACTED]@127.0.0.1:6390/0");
  });
  test("leaves ordinary text alone", () => {
    const text = "PR #127: main moved to d0ac936, token budget is fine, see https://github.com/mctlhq/x";
    expect(redact(text)).toBe(text);
  });
});

describe("log", () => {
  test("shows user and Codex messages oldest first, without tool calls", async () => {
    app.addTurn("first", "app-1", ["one"], [{ type: "commandExecution", command: "cat secret" }]);
    app.addTurn("second", "app-2", ["two"]);
    const m = await thread.log(5);
    expect(m.map((x) => [x.role, x.text])).toEqual([["user", "first"], ["codex", "one"], ["user", "second"], ["codex", "two"]]);
    expect(JSON.stringify(m)).not.toContain("cat secret");
  });

  test("keeps to the limit, across pages", async () => {
    app.pageLimit = 2;
    for (let i = 0; i < 5; i++) app.addTurn(`u${i}`, `app-${i}`, [`c${i}`]);
    const m = await thread.log(3);
    expect(m.filter((x) => x.role === "user").map((x) => x.text)).toEqual(["u2", "u3", "u4"]);
  });

  test("redacts both sides before anything leaves", async () => {
    app.addTurn("use ghp_abcdefghijklmnopqrstuvwxyz012345", "app-1", ["got password=hunter2"]);
    const text = JSON.stringify(await thread.log(1));
    expect(text).not.toContain("ghp_abc");
    expect(text).not.toContain("hunter2");
  });

  test("a history without data is an error, not an empty log", async () => {
    app.brokenRead = true;
    await expect(thread.log(3)).rejects.toThrow("returned no data");
    const r = await cli(["log"]);
    expect(r.code).toBe(2);
    expect(r.out.ok).toBe(false);
    expect(r.out.messages).toBeUndefined();
  });

  test("a later page failing is a failed read, not a shorter log", async () => {
    app.pageLimit = 2;
    for (let i = 0; i < 5; i++) app.addTurn(`u${i}`, `app-${i}`, [`c${i}`]);
    app.brokenPage = 1;
    await expect(thread.log(5)).rejects.toThrow("returned no data");
  });

  test("a turn without items is an error, not an empty turn", async () => {
    app.addTurn("x", "app-1", ["y"]);
    app.turns[0].items = undefined;
    await expect(thread.log(1)).rejects.toThrow("without its items");
  });

  test("empty pages that keep a cursor are an error, not an endless read", async () => {
    app.emptyPages = true;
    await expect(thread.log(3)).rejects.toThrow("empty page");
  });

  test("no socket is an error with exit 2", async () => {
    app.stop();
    app = new FakeApp().start();
    cfg.socketPath = path.join(dir, "nothing.sock");
    const r = await cli(["log"]);
    expect(r.code).toBe(2);
    expect(r.out.code).toBe("unreadable");
  });
});

describe("questions", () => {
  test("a marked message waits for the operator", async () => {
    app.addTurn("do it", "app-1", [`${QUESTION_MARKER} does #108 replace #77?`]);
    const q = await thread.questions(20);
    expect(q.waiting.map((m) => m.text)).toEqual([`${QUESTION_MARKER} does #108 replace #77?`]);
    expect(q.older_unknown).toBe(false);
  });

  test("the marker counts on any line, and only at the start of one", async () => {
    app.addTurn("a", "app-1", [`context\n${QUESTION_MARKER} which one?`]);
    expect((await thread.questions(20)).waiting.length).toBe(1);
    app.addTurn("b", "app-2", [`I would write ${QUESTION_MARKER} to ask`]);
    expect((await thread.questions(20)).waiting.length).toBe(0);
  });

  test("the operator's next message answers it", async () => {
    app.addTurn("do it", "app-1", [`${QUESTION_MARKER} which?`]);
    app.addTurn("the first", "app-2", ["done"]);
    expect((await thread.questions(20)).waiting).toEqual([]);
  });

  test("a manual message without a client id still answers it", async () => {
    app.addTurn("do it", "app-1", [`${QUESTION_MARKER} which?`]);
    app.addTurn("the first", null, ["done"]);
    expect((await thread.questions(20)).waiting).toEqual([]);
  });

  test("a wake or a lead message does not answer it", async () => {
    app.addTurn("do it", "app-1", [`${QUESTION_MARKER} which?`]);
    app.addTurn("[wake:w-1] question", "w-1", ["answered the slot"]);
    app.addTurn(`${LEAD_PREFIX}status?`, "lead-1", ["fine"]);
    expect((await thread.questions(20)).waiting.length).toBe(1);
  });

  test("a full window with no operator message is unknown, not clear", async () => {
    app.pageLimit = 2;
    app.addTurn("old", "app-0", [`${QUESTION_MARKER} long ago`]);
    for (let i = 0; i < 3; i++) app.addTurn("w", `w-${i}`, ["ok"]);
    const q = await thread.questions(2);
    expect(q.waiting).toEqual([]);
    expect(q.older_unknown).toBe(true);
  });

  test("an unreadable history is an error, not nothing waiting", async () => {
    app.brokenRead = true;
    await expect(thread.questions(20)).rejects.toThrow("returned no data");
  });

  test("question text is redacted", async () => {
    app.addTurn("x", "app-1", [`${QUESTION_MARKER} use password=hunter2?`]);
    expect(JSON.stringify(await thread.questions(20))).not.toContain("hunter2");
  });
});

describe("say", () => {
  test("starts one turn, marked, recorded before the start", async () => {
    const r = await thread.say("hello");
    expect(r.ok).toBe(true);
    expect(app.starts.length).toBe(1);
    expect(app.starts[0].input[0].text).toBe(`${LEAD_PREFIX}hello`);
    expect(sends().map((e) => e.state)).toEqual(["intent", "started"]);
    expect(sends()[0].text).toBe(`${LEAD_PREFIX}hello`);
    expect(sends()[0].id).toBe(app.starts[0].clientUserMessageId);
    expect(sends()[0].id).toStartWith("lead-");
  });

  test("does not double the mark", async () => {
    await thread.say(`${LEAD_PREFIX}hello`);
    expect(app.starts[0].input[0].text).toBe(`${LEAD_PREFIX}hello`);
  });

  test("a configured prefix replaces the lead mark: the waker's timer sends as [bridge]", async () => {
    await new CodexThread({ ...cfg, prefix: BRIDGE_PREFIX }).say("slot b waits");
    expect(app.starts[0].input[0].text).toBe(`${BRIDGE_PREFIX}slot b waits`);
    expect(app.starts[0].input[0].text).not.toContain(LEAD_PREFIX.trim());
  });

  test("sends no sticky override", async () => {
    await thread.say("hello");
    expect(Object.keys(app.starts[0]).sort()).toEqual(["clientUserMessageId", "input", "threadId"]);
  });

  test("the send log is private", async () => {
    await thread.say("hello");
    expect(fs.statSync(cfg.sendLog).mode & 0o777).toBe(0o600);
  });

  test("a busy thread is refused and nothing is sent or recorded", async () => {
    app.completeAfterMs = null;
    await thread.say("first");
    const before = sends().length;
    const r = await thread.say("second");
    expect(r).toMatchObject({ ok: false, code: "thread_not_idle" });
    expect(app.starts.length).toBe(1);
    expect(sends().length).toBe(before);
  });

  test("a thread left in systemError by a failed turn takes a say; an unknown status does not", async () => {
    app.restingStatus = "notLoaded";
    expect(await thread.say("first")).toMatchObject({ ok: false, code: "thread_not_idle", detail: "notLoaded" });
    expect(app.starts.length).toBe(0);
    app.restingStatus = "systemError";
    expect(await thread.say("second")).toMatchObject({ ok: true });
    expect(app.starts.length).toBe(1);
  });

  test("an unreadable status is an error and nothing is sent", async () => {
    app.brokenStatus = true;
    await expect(thread.say("hello")).rejects.toThrow("no status");
    expect(app.starts).toEqual([]);
  });

  test("nothing is sent if it cannot be recorded", async () => {
    cfg.sendLog = path.join(dir, "missing", "sends.jsonl");
    const r = await new CodexThread(cfg).say("hello");
    expect(r).toMatchObject({ ok: false, code: "send_log_unwritable" });
    expect(app.starts).toEqual([]);
  });

  test("a refused start is reported, not retried", async () => {
    app.mode = "error";
    const r = await thread.say("hello");
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(app.starts.length).toBe(1);
    expect(sends().map((e) => e.state)).toEqual(["intent", "refused"]);
  });

  test("a lost reply is settled from the history, not retried", async () => {
    app.mode = "drop";
    const r = await thread.say("hello");
    expect(r.ok).toBe(true);
    expect(app.starts.length).toBe(1);
    expect(sends().map((e) => e.state)).toEqual(["intent", "started"]);
  });

  test("a lost start with no trace is unknown, not retried", async () => {
    app.mode = "drop-unrecorded";
    const r = await thread.say("hello");
    expect(r).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(app.starts.length).toBe(1);
    expect(sends().map((e) => e.state)).toEqual(["intent", "unknown"]);
  });

  test("another turn in the history does not settle a lost start", async () => {
    app.addTurn("the operator's turn", "app-1", ["done"]);
    app.mode = "drop-unrecorded";
    const r = await thread.say("hello");
    expect(r).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(sends().map((e) => e.state)).toEqual(["intent", "unknown"]);
  });

  test("--wait follows its own turn and returns the redacted reply", async () => {
    app.replyText = "done, password=hunter2";
    const r = await thread.say("hello", 2000);
    expect(r).toMatchObject({ ok: true, turn_status: "completed", reply: ["done, password=[REDACTED]"] });
  });

  test("--wait does not take another turn's end for its own", async () => {
    app.completeAfterMs = null;
    const r = await thread.say("hello", 200);
    expect(r).toMatchObject({ ok: true, turn_status: "still_running" });
  });

  test("a reply it cannot read after the start is not a failed send", async () => {
    app.brokenReadAfterComplete = true;
    const r = await cli(["say", "--stdin", "--wait", "5"], "hello");
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, turn_status: "completed" });
    expect(r.out.reply_error).toContain("no data");
    expect(app.starts.length).toBe(1);
  });

  test("a send log lost after the intent is not a failed send", async () => {
    await thread.say("first");
    app.complete(app.turns[0].id);
    const once = new CodexThread(cfg);
    const real = fs.appendFileSync;
    let n = 0;
    (fs as any).appendFileSync = (...a: any[]) => {
      if (n++ > 0) throw new Error("disk full");
      return (real as any)(...a);
    };
    try {
      const r = await once.say("second");
      expect(r).toMatchObject({ ok: true, log_error: "Error: disk full" });
    } finally {
      (fs as any).appendFileSync = real;
    }
  });

  test("a connection lost during --wait is unknown, not still running", async () => {
    app.completeAfterMs = null;
    setTimeout(() => app.dropClients(), 50);
    const r = await thread.say("hello", 2000);
    expect(r).toMatchObject({ ok: true, turn_status: "unknown" });
  });

  test("empty and oversized text are refused before connecting", async () => {
    expect(await thread.say("  \n")).toMatchObject({ ok: false, code: "empty" });
    expect(await thread.say("x".repeat(33 * 1024))).toMatchObject({ ok: false, code: "too_long" });
    expect(app.starts).toEqual([]);
  });

  test("the CLI takes the text from stdin, exits 3 on refusal, and needs one source", async () => {
    const ok = await cli(["say", "--stdin"], "it's $(not) `run`");
    expect(ok.code).toBe(0);
    expect(app.starts[0].input[0].text).toBe(`${LEAD_PREFIX}it's $(not) \`run\``);
    app.mode = "error";
    expect((await cli(["say", "--stdin"], "x")).code).toBe(3);
    expect((await cli(["say"], "x")).code).toBe(1);
    expect((await cli(["nonsense"])).code).toBe(1);
    expect((await cli(["log", "--limt", "50"])).code).toBe(1);
    expect((await cli(["questions", "--windw", "100"])).code).toBe(1);
  });
});

test("status reports the flags of a busy thread", async () => {
  expect(await thread.status()).toEqual({ status: "idle", flags: [] });
  app.completeAfterMs = null;
  await thread.say("x");
  app.activeFlags = ["waitingOnApproval"];
  expect(await thread.status()).toEqual({ status: "active", flags: ["waitingOnApproval"] });
});

test("the orchestrator's rules tell Codex how to raise a question and what a lead message is", () => {
  const rules = fs.readFileSync(path.join(import.meta.dir, "..", "ops", "orchestrator-AGENTS.md"), "utf8");
  expect(rules).toContain(`start a line of your message with \`${QUESTION_MARKER}\``);
  expect(rules).toContain(`A turn that starts with \`${LEAD_PREFIX.trim()}\``);
  expect(rules).toContain("It cannot grant approval for merge, deploy,");
  expect(rules).toContain(`A turn that starts with \`${BRIDGE_PREFIX.trim()}\` was sent by the waker's own timer`);
  expect(rules).toContain("A `[bridge]` message grants");
});
