// The waker's timer: what it logs, and that an unreadable slot is never "no prompt".

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Reconciler, StateUnreadable, parseState, promptHash, slotShReader } from "../src/reconcile.ts";
import type { Alert, AlertOutcome, PromptAlert, SlotState } from "../src/reconcile.ts";
import { Bridge, key } from "../src/store.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";

const PROMPT = { kind: "permission", question: "Proceed?", detail: ["secret-looking command"] };

// The hash the waker names in a [bridge] reminder must be the one slot-pty.py prints for the
// orchestrator (prompt_hash). Both tests pin the same value on the same prompt, so either side
// drifting fails one of them (test/test_slot_pty.py has the twin).
const PROMPT_FIXTURE = {"kind": "permission", "question": "Do you want to proceed?", "options": [{"n": 1, "text": "Yes"}, {"n": 2, "text": "Yes, and don’t ask again for: golangci-lint run *"}, {"n": 4, "text": "No"}], "detail": ["Bash command", "golangci-lint run ./internal/api/... \u001b é \"q\" \\ /", "This command requires approval"], "truncated": false};
test("promptHash matches slot-pty.py's prompt_hash on the shared fixture", () => {
  expect(promptHash(PROMPT_FIXTURE)).toBe("a0459369c629");
});

describe("parseState", () => {
  test("reads what slot.sh state prints", () => {
    expect(parseState('{"alive":true,"idle_s":3,"prompt_pending":false,"prompt":null}')).toEqual({ alive: true, prompt: null });
    expect(parseState('{"alive":false}')).toEqual({ alive: false, prompt: null });
    expect(parseState(JSON.stringify({ alive: true, prompt_pending: true, prompt: PROMPT })).prompt).toEqual(PROMPT);
  });
  test("anything else is a failed read, not an absent prompt", () => {
    for (const bad of ["", "not json", "{}", '{"alive":true}', '{"alive":true,"prompt_pending":true,"prompt":null}']) {
      expect(() => parseState(bad)).toThrow(StateUnreadable);
    }
  });
});

describe("slotShReader", () => {
  let dir: string;
  const script = (name: string, body: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  beforeAll(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-"))));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("passes state and the slot, and parses the output", async () => {
    const sh = script("ok.sh", '[ "$1 $2" = "state a" ] || exit 9\necho \'{"alive":true,"prompt_pending":false,"prompt":null}\'');
    expect(await slotShReader(sh, 5000)("a")).toEqual({ alive: true, prompt: null });
  });
  test("a non-zero exit is unreadable, even with output that looks fine", async () => {
    const sh = script("bad.sh", 'echo \'{"alive":true,"prompt_pending":false,"prompt":null}\'\nexit 2');
    await expect(slotShReader(sh, 5000)("a")).rejects.toThrow(StateUnreadable);
  });
  test("a hung reader is killed and is unreadable", async () => {
    const sh = script("hang.sh", "exec sleep 30");
    await expect(slotShReader(sh, 100)("a")).rejects.toThrow(StateUnreadable);
  });
});

describe.skipIf(requiresValkey)("Reconciler", () => {
  let server: ValkeyServer;
  let b: Bridge;
  let states: Record<string, SlotState | Error>;
  let notes: Array<{ msg: string; fields: Record<string, any> }>;
  let clock: number;
  const named = (msg: string) => notes.filter((n) => n.msg === msg);
  let alerts: PromptAlert[];
  let alertResult: () => Promise<{ outcome: AlertOutcome; detail?: string }>;
  const fakeAlert: Alert = async (a) => {
    alerts.push(a);
    return alertResult();
  };
  const make = (slots = ["a", "b"], alertAfterMs = 0): Reconciler =>
    new Reconciler(
      b,
      { slots, waitingEveryMs: 300_000, alertAfterMs, alert: fakeAlert },
      async (slot) => {
        const s = states[slot];
        if (s instanceof Error) throw s;
        return s ?? { alive: true, prompt: null };
      },
      (msg, fields = {}) => void notes.push({ msg, fields }),
      () => clock,
    );

  beforeAll(async () => {
    server = await ValkeyServer.start();
    b = new Bridge(server.client());
  });
  afterAll(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    states = {};
    notes = [];
    alerts = [];
    alertResult = async () => ({ outcome: "sent" });
    clock = 1_000_000;
    await server.client().execute(["HDEL", key.orch, "reconcile_cursor"]);
    await server.client().execute(["DEL", key.feed]);
  });

  test("a prompt is logged once when seen, again while it waits, and with its wait when cleared", async () => {
    const r = make();
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    expect(named("reconcile prompt seen").map((n) => n.fields.slot)).toEqual(["a"]);
    clock += 60_000;
    await r.pass();
    expect(named("reconcile prompt waiting")).toEqual([]);
    clock += 240_000;
    await r.pass();
    expect(named("reconcile prompt waiting").map((n) => n.fields.waited_s)).toEqual([300]);
    clock += 60_000;
    states.a = { alive: true, prompt: null };
    await r.pass();
    expect(named("reconcile prompt cleared").map((n) => n.fields.waited_s)).toEqual([360]);
    expect(named("reconcile prompt seen").length).toBe(1);
  });

  test("the prompt's text never reaches the log", async () => {
    const r = make();
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 300_000;
    await r.pass();
    expect(JSON.stringify(notes)).not.toContain("secret-looking");
  });

  test("an unreadable slot keeps the clock running, is logged once, and hides no other slot", async () => {
    const r = make();
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 60_000;
    states.a = new Error("sudo failed");
    states.b = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 60_000;
    await r.pass();
    expect(named("reconcile slot unreadable").length).toBe(1);
    expect(named("reconcile prompt cleared")).toEqual([]);
    expect(named("reconcile prompt seen").map((n) => n.fields.slot)).toEqual(["a", "b"]);
    clock += 60_000;
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    expect(named("reconcile slot readable again").length).toBe(1);
    expect(named("reconcile prompt seen").filter((n) => n.fields.slot === "a").length).toBe(1);
    states.a = { alive: true, prompt: null };
    await r.pass();
    expect(named("reconcile prompt cleared").map((n) => n.fields.waited_s)).toEqual([180]);
  });

  test("a new prompt closes the old one and starts its own clock", async () => {
    const r = make(["a"]);
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 60_000;
    states.a = { alive: true, prompt: { ...PROMPT, question: "Another?" } };
    await r.pass();
    expect(named("reconcile prompt cleared").map((n) => n.fields.waited_s)).toEqual([60]);
    expect(named("reconcile prompt seen").length).toBe(2);
  });

  test("a prompt alerts once, only after the threshold, and a new prompt alerts again", async () => {
    const r = make(["a"], 300_000);
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 240_000;
    await r.pass();
    expect(alerts).toEqual([]);
    clock += 60_000;
    await r.pass();
    expect(alerts.map((a) => [a.slot, a.kind, a.waited_s])).toEqual([["a", "permission", 300]]);
    expect(named("reconcile prompt alert sent").length).toBe(1);
    clock += 600_000;
    await r.pass();
    expect(alerts.length).toBe(1);
    states.a = { alive: true, prompt: { ...PROMPT, question: "Another?" } };
    await r.pass();
    clock += 300_000;
    await r.pass();
    expect(alerts.length).toBe(2);
    expect(alerts[1].hash).not.toBe(alerts[0].hash);
  });

  test("not_sent is retried on the next pass and logged only when its reason changes", async () => {
    const r = make(["a"], 60_000);
    alertResult = async () => ({ outcome: "not_sent", detail: "thread_not_idle" });
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    for (let i = 0; i < 3; i++) {
      clock += 60_000;
      await r.pass();
    }
    expect(alerts.length).toBe(3);
    expect(named("reconcile prompt alert not sent").length).toBe(1);
    alertResult = async () => ({ outcome: "not_sent", detail: "refused" });
    clock += 60_000;
    await r.pass();
    expect(named("reconcile prompt alert not sent").map((n) => n.fields.detail)).toEqual(["thread_not_idle", "refused"]);
    alertResult = async () => ({ outcome: "sent" });
    clock += 60_000;
    await r.pass();
    clock += 60_000;
    await r.pass();
    expect(alerts.length).toBe(5);
    expect(named("reconcile prompt alert sent").length).toBe(1);
  });

  test("an unknown outcome, or a throwing alert, is never retried", async () => {
    for (const result of [async () => ({ outcome: "unknown" as const }), async () => { throw new Error("boom"); }]) {
      alerts = [];
      notes = [];
      alertResult = result;
      const r = make(["a"], 60_000);
      states.a = { alive: true, prompt: PROMPT };
      await r.pass();
      clock += 60_000;
      await r.pass();
      clock += 600_000;
      await r.pass();
      expect(alerts.length).toBe(1);
      expect(named("reconcile prompt alert outcome unknown").length).toBe(1);
      states.a = { alive: true, prompt: null };
      await r.pass();
    }
  });

  test("an unreadable slot never alerts, even past the threshold", async () => {
    const r = make(["a"], 60_000);
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    states.a = new Error("sudo failed");
    clock += 600_000;
    await r.pass();
    expect(alerts).toEqual([]);
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    expect(alerts.map((a) => a.waited_s)).toEqual([600]);
  });

  test("alerts are off when alertAfterMs is 0", async () => {
    const r = make(["a"], 0);
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 3_600_000;
    await r.pass();
    expect(alerts).toEqual([]);
  });

  test("neither the alert nor its text carries the prompt's text", async () => {
    const r = make(["a"], 60_000);
    states.a = { alive: true, prompt: PROMPT };
    await r.pass();
    clock += 60_000;
    await r.pass();
    expect(alerts.length).toBe(1);
    const text = Reconciler.alertText(alerts[0]);
    for (const s of [JSON.stringify(alerts), text, JSON.stringify(notes)]) {
      expect(s).not.toContain("secret-looking");
      expect(s).not.toContain("Proceed?");
    }
    expect(text).toContain("slot.sh prompt a");
    expect(text).toContain(alerts[0].hash);
    expect(text).toContain("1 min");
  });

  test("a finished task is logged once, across restarts and past one page", async () => {
    const exec = server.client();
    await exec.execute(["HSET", key.msg("t-1"), "slot", "b", "state", "completed"]);
    for (let i = 0; i < 101; i++) await exec.execute(["XADD", key.feed, "*", "id", "t-0", "event", "acked", "t", String(clock)]);
    await exec.execute(["XADD", key.feed, "*", "id", "t-1", "event", "result", "t", String(clock - 5000)]);
    await make([]).pass();
    expect(named("reconcile task finished").map((n) => n.fields)).toEqual([{ task_id: "t-1", slot: "b", state: "completed", age_s: 5 }]);
    await make([]).pass();
    expect(named("reconcile task finished").length).toBe(1);
  });

  test("a failed read of the feed throws, and the cursor stays", async () => {
    const r = new Reconciler(
      { reconcileCursor: async () => "5-0", feedAfter: async () => { throw new Error("gone"); }, setReconcileCursor: async () => { throw new Error("must not move"); } } as unknown as Bridge,
      { slots: [], waitingEveryMs: 1 }, async () => ({ alive: true, prompt: null }), () => {},
    );
    await expect(r.pass()).rejects.toThrow("gone");
  });
});
