// The orchestrator-side consumer of the slots' request streams (slice 4b).
//
// For every slot on the allow list it reads `s:<slot>:out` after that slot's
// checkpoint and hands each entry to `bridge_ingest`. The slot's identity is the
// name of the stream the entry came from; whatever the entry says about who sent it
// is ignored. One call applies the request, stores the answer, appends it to the
// slot's response stream and moves the checkpoint, so a crash between entries
// repeats nothing and loses nothing.

import fs from "node:fs";

import { Bridge, PREFIX, key, pairs, text } from "./store.ts";
import { Connection, ValkeyError, endpointFromUrl } from "./valkey.ts";
import type { Reply } from "./valkey.ts";

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), src: "mctl-bridge-ingest", msg, ...fields }) + "\n");
}

export class Ingester {
  private readonly bridge: Bridge;
  private readonly cursors = new Map<string, string>();
  private stopped = false;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  stop(): void {
    this.stopped = true;
  }

  private async cursor(slot: string): Promise<string> {
    let c = this.cursors.get(slot);
    if (c === undefined) {
      const stored = await this.bridge.exec.execute(["GET", key.checkpoint(slot)]);
      c = stored === null ? "0-0" : text(stored);
      this.cursors.set(slot, c);
    }
    return c;
  }

  /** One pass over every allowed slot; returns how many entries were handled. */
  async step(blockMs = 0): Promise<number> {
    const slots = await this.bridge.members(key.allowed);
    if (slots.length === 0) return 0;
    const ids = await Promise.all(slots.map((s) => this.cursor(s)));
    const cmd: Array<string | number> = ["XREAD", "COUNT", 100];
    if (blockMs > 0) cmd.push("BLOCK", blockMs);
    cmd.push("STREAMS", ...slots.map((s) => key.out(s)), ...ids);
    const reply = await this.bridge.exec.execute(cmd, { timeout: blockMs / 1000 + 10 });
    if (!Array.isArray(reply)) return 0;
    let handled = 0;
    for (const stream of reply) {
      const [name, entries] = stream as Reply[];
      const slot = text(name!).slice(`${PREFIX}s:`.length, -":out".length);
      for (const e of entries as Reply[]) {
        const [id, fields] = e as Reply[];
        await this.apply(slot, text(id!), pairs(fields!));
        handled++;
      }
    }
    return handled;
  }

  private async apply(slot: string, entry: string, f: Record<string, string>): Promise<void> {
    const call = (fn: string, args: string[]) =>
      this.bridge.exec.execute(["FCALL", fn, 1, key.orch, ...args]);
    try {
      await call("bridge_ingest", [slot, entry, f.rid ?? "", f.fn ?? "", f.args ?? ""]);
    } catch (err) {
      // A script error (not a lost connection) would otherwise be retried for ever and
      // block every later request from this slot: record it as a rejection and go on.
      if (!(err instanceof ValkeyError)) throw err;
      log("handler error, entry rejected", { slot, entry, error: err.message });
      await call("bridge_ingest_poison", [slot, entry, "handler_error"]);
    }
    this.cursors.set(slot, entry);
  }

  async run(blockMs = 1000): Promise<void> {
    let backoff = 200;
    while (!this.stopped) {
      try {
        const n = await this.step(blockMs);
        backoff = 200;
        if (n === 0 && blockMs === 0) await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        log("step failed", { error: err instanceof Error ? err.message : String(err) });
        backoff = Math.min(backoff * 2, 5000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}

export async function main(): Promise<number> {
  const url = process.env.MCTL_BRIDGE_VALKEY_URL ?? "";
  if (!url) {
    log("MCTL_BRIDGE_VALKEY_URL is required");
    return 2;
  }
  const pwFile = process.env.MCTL_BRIDGE_VALKEY_PASSWORD_FILE;
  const password = pwFile ? fs.readFileSync(pwFile, "utf8").replace(/[\r\n]+$/, "") : null;
  const bridge = new Bridge(new Connection(endpointFromUrl(url, password)));
  await bridge.checkVersion();
  const ingester = new Ingester(bridge);
  process.on("SIGTERM", () => ingester.stop());
  process.on("SIGINT", () => ingester.stop());
  log("started");
  await ingester.run();
  return 0;
}

if (import.meta.main) process.exitCode = await main();
