// The waker's timer: notices what nobody is waiting for. Between Codex turns no one sees a
// slot stop on a permission prompt, or a task result that nobody collects.
//
// First stage, log only: it starts no turn and presses nothing. Its log says how long slots
// really wait, which is what a later stage has to act on. Slot screens can hold secrets, so
// a prompt is logged by kind and hash, never by its text.
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

export function promptHash(prompt: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 12);
}

export type ReadState = (slot: string) => Promise<SlotState>;
export type Note = (msg: string, fields?: Record<string, unknown>) => void;

export interface ReconcileConfig {
  slots: string[];
  /** A prompt still waiting is logged again this often. */
  waitingEveryMs: number;
}

interface Waiting {
  hash: string;
  kind: unknown;
  since: number;
  lastNote: number;
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
      return;
    }
    if (held) this.note("reconcile prompt cleared", { slot, hash: held.hash, waited_s: Math.round((now - held.since) / 1000), slot_alive: st.alive });
    this.waiting.set(slot, { hash, kind: st.prompt.kind, since: now, lastNote: now });
    this.note("reconcile prompt seen", { slot, hash, kind: st.prompt.kind });
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
