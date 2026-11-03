// Test support: a throwaway valkey-server/redis-server, optionally durable.
//
// The state machine runs as a server-side function library, so a fake server
// would only prove the fake. The durable profile keeps its data directory
// across a SIGKILL so recovery can be tested against the real AOF.

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Bridge, loadLibrary } from "../src/store.ts";
import { Connection, endpointFromUrl } from "../src/valkey.ts";

function which(name: string): string | null {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export const VALKEY_SERVER = which("valkey-server") ?? which("redis-server");
/** CI installs a server; without one these tests cannot say anything. */
export const requiresValkey = VALKEY_SERVER === null;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export class ValkeyServer {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-valkey-"));
  readonly durable: boolean;
  port = 0;
  url = "";
  private proc: ChildProcess | null = null;
  private clients: Connection[] = [];

  private constructor(durable: boolean) {
    this.durable = durable;
  }

  /** `durable`: AOF with fsync on every write, as the bridge runs in production. */
  static async start(o: { durable?: boolean } = {}): Promise<ValkeyServer> {
    const server = new ValkeyServer(o.durable ?? false);
    server.port = await freePort();
    server.url = `redis://127.0.0.1:${server.port}/0`;
    await server.launch();
    return server;
  }

  private async launch(): Promise<void> {
    const persistence = this.durable
      ? ["--save", "", "--appendonly", "yes", "--appendfsync", "always"]
      : ["--save", "", "--appendonly", "no"];
    this.proc = spawn(
      VALKEY_SERVER!,
      ["--port", String(this.port), "--bind", "127.0.0.1", ...persistence, "--dir", this.dir],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
      const probe = new Connection(endpointFromUrl(this.url), 1);
      try {
        await probe.execute(["PING"]);
        return;
      } catch (exc) {
        if (Date.now() > deadline) throw exc;
        await sleep(50);
      } finally {
        probe.close();
      }
    }
  }

  private async kill(signal: NodeJS.Signals): Promise<void> {
    const proc = this.proc;
    if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill(signal);
    });
  }

  /** SIGKILL, then start again on the same data directory. */
  async crashAndRestart(): Promise<void> {
    for (const conn of this.clients) conn.close();
    await this.kill("SIGKILL");
    await this.launch();
  }

  client(): Connection {
    const conn = new Connection(endpointFromUrl(this.url));
    this.clients.push(conn);
    return conn;
  }

  async bridge(): Promise<Bridge> {
    const conn = this.client();
    await loadLibrary(conn);
    return new Bridge(conn);
  }

  async stop(): Promise<void> {
    for (const conn of this.clients) conn.close();
    await this.kill("SIGTERM");
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
