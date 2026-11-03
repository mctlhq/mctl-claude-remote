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

// ---- a fake Claude Code client for the slot adapter --------------------------

import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";

export type Message = Record<string, any>;
export const CHANNEL_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "channel.ts");
export const BUNFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bunfig.toml");

/** Speaks the client half of MCP stdio to a spawned adapter, and plays the hooks. */
export class FakeClaude {
  readonly stateDir: string;
  readonly pid: number;
  readonly proc: ChildProcess;
  readonly stderr: string[] = [];
  readonly exited: Promise<number | null>;
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<() => void>();
  private id = 0;

  constructor(url: string, slot: string, o: { stateDir: string; pid?: number; env?: Record<string, string> }) {
    this.stateDir = o.stateDir;
    // The "claude" process the adapter believes it serves: this test process.
    this.pid = o.pid ?? process.pid;
    this.proc = spawnChild(process.execPath, ["run", "--silent", "--no-env-file", `--config=${BUNFIG}`, CHANNEL_TS], {
      env: {
        ...process.env,
        MCTL_BRIDGE_SLOT: slot,
        MCTL_BRIDGE_VALKEY_URL: url,
        MCTL_BRIDGE_STATE_DIR: this.stateDir,
        MCTL_BRIDGE_CLAUDE_PID: String(this.pid),
        MCTL_BRIDGE_POLL_MS: "30",
        MCTL_BRIDGE_HEARTBEAT_MS: "1000",
        MCTL_BRIDGE_STARTUP_GRACE_MS: "50",
        MCTL_BRIDGE_EMIT_HOLD_MS: "5000",
        CLAUDE_CODE_SESSION_ID: "",
        ...o.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.proc.once("exit", (code) => resolve(code)));
    let out = "";
    this.proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      let at: number;
      while ((at = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, at);
        out = out.slice(at + 1);
        if (line.trim()) this.messages.push(JSON.parse(line));
      }
      for (const wake of this.listeners) wake();
    });
    this.proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => this.stderr.push(chunk));
    this.proc.stdin!.on("error", () => undefined);
  }

  /** What the hooks would write: SessionStart/Stop = idle, UserPromptSubmit = busy. */
  hook(state: "busy" | "idle", sessionId: string): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, `${this.pid}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ session_id: sessionId, state, t: Date.now() / 1000 }));
    fs.renameSync(tmp, file);
  }

  send(message: Message): void {
    this.proc.stdin!.write(JSON.stringify(message) + "\n");
  }

  async request(method: string, params: Message): Promise<Message> {
    const id = ++this.id;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.wait((m) => m.id === id);
  }

  async wait(predicate: (m: Message) => boolean, timeout = 10.0): Promise<Message> {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out; stderr=${this.stderr.join("").slice(-2000)}`);
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.listeners.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.listeners.add(wake);
      });
    }
  }

  notification(timeout = 10.0): Promise<Message> {
    return this.wait((m) => m.method === "notifications/claude/channel", timeout);
  }

  async noNotification(seconds: number): Promise<void> {
    let message: Message;
    try {
      message = await this.notification(seconds);
    } catch {
      return;
    }
    throw new Error(`unexpected notification: ${JSON.stringify(message)}`);
  }

  async handshake(): Promise<Message> {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-claude", version: "0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  }

  async call(name: string, args: Message = {}): Promise<{ isError: boolean; body: any }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const text = reply.result.content[0].text;
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // a plain error message
    }
    return { isError: reply.result.isError ?? false, body };
  }

  async kill(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
    await this.exited;
  }

  /** Close stdin, as Claude Code does on exit, and wait for a clean stop. */
  async close(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.stdin!.end();
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 10_000);
      await this.exited;
      clearTimeout(timer);
    }
  }
}
