// The waker's timer: notices what nobody is waiting for. Between Codex turns no one sees a
// slot stop on a permission prompt, or a task result that nobody collects.
//
// It presses nothing. It logs how long slots really wait, and once a prompt has waited
// `alertAfterMs` it tells the orchestrator, which is the one that answers prompts: one alert per
// prompt, by slot, kind, hash and wait. Slot screens can hold secrets, so a prompt reaches the
// log and the alert by kind and hash, never by its text; the orchestrator reads the text itself.
//
// An alert that was definitely not sent (the thread is busy, the start was refused) is tried
// again on a later pass. One whose outcome is unknown is not: a second copy is worse than a
// late one, and the log says which happened.
//
// A slot whose state could not be read is unknown: the prompt's clock keeps running, because
// not seeing a prompt is not seeing it gone. Only a state that says so clears it.

import crypto from "node:crypto";

import type { Bridge } from "./store.ts";

export class StateUnreadable extends Error {}

export interface SlotState {
  alive: boolean;
  prompt: Record<string, unknown> | null;
}

/** `slot.sh state` prints JSON. Anything else, or a field missing, is a failed read. */
export function parseState(raw: string): SlotState {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new StateUnreadable(`not JSON: ${raw.slice(0, 80)}`);
  }
  if (typeof d?.alive !== "boolean") throw new StateUnreadable("no alive field");
  if (!d.alive) return { alive: false, prompt: null };
  if (typeof d.prompt_pending !== "boolean") throw new StateUnreadable("no prompt_pending field");
  if (!d.prompt_pending) return { alive: true, prompt: null };
  if (typeof d.prompt !== "object" || d.prompt === null) throw new StateUnreadable("prompt_pending without a prompt");
  return { alive: true, prompt: d.prompt };
}

/** Must stay byte for byte equal to prompt_hash in ops/slot-pty.py, which prints it for the orchestrator. */
export function promptHash(prompt: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 12);
}

export type ReadState = (slot: string) => Promise<SlotState>;
export type Note = (msg: string, fields?: Record<string, unknown>) => void;

export type AlertOutcome = "sent" | "not_sent" | "unknown";
export interface PromptAlert {
  slot: string;
  hash: string;
  kind: unknown;
  waited_s: number;
}
/** Tell the orchestrator about a waiting prompt. `detail` says why it was not sent. */
export type Alert = (a: PromptAlert) => Promise<{ outcome: AlertOutcome; detail?: string }>;

export interface ReconcileConfig {
  slots: string[];
  /** A prompt still waiting is logged again this often. */
  waitingEveryMs: number;
  /** Alert the orchestrator once a prompt has waited this long. Absent or 0: log only. */
  alertAfterMs?: number;
  alert?: Alert;
}

interface Waiting {
  hash: string;
  kind: unknown;
  since: number;
  lastNote: number;
  /** sent or unknown: never alerted again. not_sent: tried again on the next pass. */
  alert: AlertOutcome | null;
  lastAlertDetail?: string;
}

const RESULT_PAGE = 100;

export class Reconciler {
  private readonly waiting = new Map<string, Waiting>();
  private readonly unreadable = new Set<string>();
  private readonly bridge: Bridge;
  private readonly cfg: ReconcileConfig;
  private readonly read: ReadState;
  private readonly note: Note;
  private readonly now: () => number;

  constructor(bridge: Bridge, cfg: ReconcileConfig, read: ReadState, note: Note, now: () => number = Date.now) {
    this.bridge = bridge;
    this.cfg = cfg;
    this.read = read;
    this.note = note;
    this.now = now;
  }

  /** One slot's failure does not hide the others, nor the results below. */
  async pass(): Promise<void> {
    for (const slot of this.cfg.slots) await this.observeSlot(slot);
    await this.observeResults();
  }

  private async observeSlot(slot: string): Promise<void> {
    let st: SlotState;
    try {
      st = await this.read(slot);
    } catch (err) {
      if (!this.unreadable.has(slot)) {
        this.unreadable.add(slot);
        this.note("reconcile slot unreadable", { slot, error: err instanceof Error ? err.message : String(err), prompt_clock: this.waiting.get(slot)?.hash ?? null });
      }
      return;
    }
    if (this.unreadable.delete(slot)) this.note("reconcile slot readable again", { slot });
    const now = this.now();
    const held = this.waiting.get(slot);
    if (!st.prompt) {
      if (held) {
        this.waiting.delete(slot);
        this.note("reconcile prompt cleared", { slot, hash: held.hash, waited_s: Math.round((now - held.since) / 1000), slot_alive: st.alive });
      }
      return;
    }
    const hash = promptHash(st.prompt);
    if (held?.hash === hash) {
      if (now - held.lastNote >= this.cfg.waitingEveryMs) {
        held.lastNote = now;
        this.note("reconcile prompt waiting", { slot, hash, kind: held.kind, waited_s: Math.round((now - held.since) / 1000) });
      }
      await this.maybeAlert(slot, held, now);
      return;
    }
    if (held) this.note("reconcile prompt cleared", { slot, hash: held.hash, waited_s: Math.round((now - held.since) / 1000), slot_alive: st.alive });
    const fresh: Waiting = { hash, kind: st.prompt.kind, since: now, lastNote: now, alert: null };
    this.waiting.set(slot, fresh);
    this.note("reconcile prompt seen", { slot, hash, kind: st.prompt.kind });
    await this.maybeAlert(slot, fresh, now);
  }

  /** Only after a read that shows the prompt still there: an unreadable slot never alerts. */
  private async maybeAlert(slot: string, w: Waiting, now: number): Promise<void> {
    const after = this.cfg.alertAfterMs ?? 0;
    if (!this.cfg.alert || after <= 0) return;
    if (w.alert === "sent" || w.alert === "unknown") return;
    if (now - w.since < after) return;
    const a: PromptAlert = { slot, hash: w.hash, kind: w.kind, waited_s: Math.round((now - w.since) / 1000) };
    let r: { outcome: AlertOutcome; detail?: string };
    try {
      r = await this.cfg.alert(a);
    } catch (err) {
      // The alert function reports an outcome; a throw is a bug in it, and nothing says
      // whether a turn started, so it is treated as unknown rather than retried.
      r = { outcome: "unknown", detail: err instanceof Error ? err.message : String(err) };
    }
    w.alert = r.outcome;
    if (r.outcome === "not_sent") {
      // Logged when the reason changes, not on every pass while the thread stays busy.
      if (w.lastAlertDetail !== r.detail) this.note("reconcile prompt alert not sent", { ...a, detail: r.detail ?? null });
      w.lastAlertDetail = r.detail;
      return;
    }
    this.note(r.outcome === "sent" ? "reconcile prompt alert sent" : "reconcile prompt alert outcome unknown", { ...a, ...(r.detail ? { detail: r.detail } : {}) });
  }

  /** What the orchestrator reads: slot, kind, hash and wait, never the prompt's text. */
  static alertText(a: PromptAlert): string {
    const min = Math.floor(a.waited_s / 60);
    return [
      `Slot ${a.slot} has waited ${min >= 1 ? `${min} min` : `${a.waited_s} s`} on a ${String(a.kind)} prompt (hash ${a.hash}).`,
      `Read it with \`slot.sh prompt ${a.slot}\` and answer it under "Permission prompts in slots" in your AGENTS.md.`,
      "This is the bridge's timer: it is not the operator or the lead, it grants nothing, and the prompt's text is left out on purpose.",
    ].join(" ");
  }

  /** Each finished task once, from a cursor that survives a restart. A failed read throws. */
  private async observeResults(): Promise<void> {
    let cursor = await this.bridge.reconcileCursor();
    for (;;) {
      const page = await this.bridge.feedAfter(cursor, RESULT_PAGE);
      for (const e of page) {
        if (e.event === "result") {
          const m = await this.bridge.message(e.id!);
          this.note("reconcile task finished", { task_id: e.id, slot: m.slot ?? null, state: m.state ?? null, age_s: Math.round((this.now() - Number(e.t)) / 1000) });
        }
        cursor = e.entry!;
      }
      if (page.length > 0) await this.bridge.setReconcileCursor(cursor);
      if (page.length < RESULT_PAGE) return;
    }
  }
}

/** The real reader: `slot.sh state <slot>`, killed if it hangs. */
export function slotShReader(slotSh: string, timeoutMs: number): ReadState {
  return async (slot) => {
    const p = Bun.spawn([slotSh, "state", slot], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), timeoutMs);
    try {
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new StateUnreadable(`slot.sh state exited ${code}: ${err.trim().slice(0, 160)}`);
      return parseState(out);
    } finally {
      clearTimeout(killer);
    }
  };
}
