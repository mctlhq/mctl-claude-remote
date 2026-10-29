// Test support: a throwaway valkey-server and a fake Claude Code client.
// Ported from events/tests/support.py.

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, endpointFromUrl } from "../src/valkey.ts";
import type { Reply } from "../src/valkey.ts";

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHANNEL_TS = path.join(PLUGIN, "src", "channel.ts");
export const TELEGRAM_TOKEN_TS = path.join(PLUGIN, "src", "telegram_token.ts");

/**
 * The bun arguments ahead of the script, exactly as the shipped `.mcp.json`
 * starts the server, so the tests exercise the command Claude Code runs. The
 * token tool is documented to run with the same ones.
 */
export const BUN_ARGS: readonly string[] = (() => {
  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".mcp.json"), "utf8"));
  const args = (config.mcpServers["mctl-events"].args as string[]).map((arg) =>
    arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN),
  );
  if (args.at(-1) !== CHANNEL_TS) throw new Error(`.mcp.json does not end with ${CHANNEL_TS}: ${args.join(" ")}`);
  return args.slice(0, -1);
})();

function which(name: string): string | null {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export const VALKEY_SERVER = which("valkey-server") ?? which("redis-server");
/** True when there is no server to test against: `describe.skipIf(requiresValkey)`. */
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

export function str(reply: Reply): string {
  return Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply);
}

export class ValkeyServer {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "valkey-test-"));
  port = 0;
  url = "";
  private proc: ChildProcess | null = null;
  private clients: Connection[] = [];

  static async start(): Promise<ValkeyServer> {
    const server = new ValkeyServer();
    server.port = await freePort();
    server.url = `redis://127.0.0.1:${server.port}/0`;
    await server.launch();
    return server;
  }

  private async launch(): Promise<void> {
    this.proc = spawn(
      VALKEY_SERVER!,
      ["--port", String(this.port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", this.dir],
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

  /** Kill and start a fresh, empty server on the same port. */
  async restart(): Promise<void> {
    await this.kill("SIGKILL");
    await this.launch();
  }

  client(): Connection {
    const conn = new Connection(endpointFromUrl(this.url));
    this.clients.push(conn);
    return conn;
  }

  async stop(): Promise<void> {
    for (const conn of this.clients) conn.close();
    await this.kill("SIGTERM");
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

export type Doc = Record<string, unknown> & { id: string; subject: Record<string, unknown> };

export function envelope(eventId = "telegram:evt:v1:7:42:1001", overrides: Record<string, unknown> = {}): Doc {
  return {
    specversion: "mctl.events/v1",
    id: eventId,
    type: "telegram.message.created",
    source: "mctl-telegram",
    occurred_at: "2026-09-17T08:00:00Z",
    correlation_id: "corr-" + eventId.replaceAll(":", "-"),
    subject: { kind: "telegram.message", account_id: "7", chat_id: "42", message_id: "1001", peer: "user:42" },
    ...overrides,
  } as Doc;
}

export const POLICY = {
  group: "claude-remote",
  consumer: "test-consumer",
  block_ms: 200,
  // The fake client registers nothing, so the settle window only slows tests
  // down; the two tests about it set their own.
  startup_grace_ms: 100,
  routes: [
    {
      stream: "mctl:events:telegram",
      sources: ["mctl-telegram"],
      types: ["telegram.message.*"],
      subject: { account_id: ["7"] },
    },
  ],
};

export type Message = Record<string, any>;

/** Speaks the client half of MCP stdio to a spawned adapter process. */
export class FakeClaude {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-test-"));
  readonly proc: ChildProcess;
  readonly stderr: string[] = [];
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<() => void>();
  private id = 0;
  readonly exited: Promise<number | null>;

  /** `cwdFiles` are written into the process's working directory before it starts. */
  constructor(
    url: string,
    policy: Record<string, unknown>,
    env: Record<string, string> = {},
    cwdFiles: Record<string, string> = {},
  ) {
    const policyPath = path.join(this.dir, "policy.json");
    fs.writeFileSync(policyPath, JSON.stringify(policy));
    for (const [name, text] of Object.entries(cwdFiles)) fs.writeFileSync(path.join(this.dir, name), text);
    this.proc = spawn(process.execPath, [...BUN_ARGS, CHANNEL_TS], {
      cwd: this.dir,
      env: { ...process.env, MCTL_EVENTS_VALKEY_URL: url, MCTL_EVENTS_POLICY: policyPath, ...env },
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
        this.messages.push(JSON.parse(line));
      }
      for (const wake of this.listeners) wake();
    });
    this.proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => this.stderr.push(chunk));
    this.proc.stdin!.on("error", () => undefined);
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
    const result = reply.result;
    const text = result.content[0].text;
    return { isError: result.isError ?? false, body: result.isError ? text : JSON.parse(text) };
  }

  async kill(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
    await this.exited;
  }

  async close(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.stdin!.end();
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 10_000);
      await this.exited;
      clearTimeout(timer);
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
