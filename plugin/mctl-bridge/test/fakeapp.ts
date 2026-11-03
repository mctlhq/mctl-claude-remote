// A fake Codex app server on a Unix socket: WebSocket at /rpc, JSON-RPC text frames
// without a `jsonrpc` field, as the real control socket speaks them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";

export type StartMode =
  | "ok" // reply with the turn
  | "drop" // record the turn, then close the connection before replying
  | "drop-unrecorded" // close the connection before replying, and start nothing
  | "error" // reply with a JSON-RPC error and start nothing
  | "hang"; // record the turn and never reply

export class FakeApp {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakeapp-"));
  readonly path = path.join(this.dir, "control.sock");
  readonly threadId: string;
  turns: any[] = [];
  starts: any[] = [];
  mode: StartMode = "ok";
  /** Complete every started turn after this many ms; null leaves it to the test. */
  completeAfterMs: number | null = 30;
  /** Send a turn/completed for another thread and another turn first. */
  foreignFirst = true;
  /** thread/read answers without turns: an unreadable history. */
  brokenRead = false;
  private server: Server<unknown> | null = null;
  private readonly sockets = new Set<ServerWebSocket<unknown>>();

  constructor(threadId = "thread-orch") {
    this.threadId = threadId;
  }

  start(): this {
    this.server = Bun.serve({
      unix: this.path,
      fetch: (req, server) => (server.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade required", { status: 400 })),
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
        },
        close: (ws) => {
          this.sockets.delete(ws);
        },
        message: (ws, data) => this.handle(ws, JSON.parse(String(data))),
      },
    });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Close every client connection, as a daemon restart would. */
  dropClients(): void {
    for (const ws of this.sockets) ws.close();
  }

  /** A turn the operator started by hand from the ChatGPT app. */
  manualTurn(text: string, status = "completed"): void {
    this.turns.push({ id: `turn-manual-${this.turns.length}`, status, items: [{ type: "userMessage", id: "u", content: [{ type: "text", text }] }] });
  }

  complete(turnId: string, status = "completed", broadcast = true): void {
    const turn = this.turns.find((t) => t.id === turnId);
    if (turn) turn.status = status;
    if (broadcast) this.broadcast({ method: "turn/completed", params: { threadId: this.threadId, turn: { id: turnId, status, items: [] } } });
  }

  private broadcast(msg: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(msg));
  }

  private handle(ws: ServerWebSocket<unknown>, m: any): void {
    if (m.id === undefined) return; // notifications such as `initialized`
    const reply = (result: unknown): void => {
      ws.send(JSON.stringify({ id: m.id, result }));
    };
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "fake-app/0" });
      case "thread/resume":
        return reply({ thread: { id: this.threadId, turns: [] } });
      case "thread/read":
        return reply(this.brokenRead ? { thread: { id: this.threadId } } : { thread: { id: this.threadId, turns: this.turns } });
      case "turn/start": {
        this.starts.push(m.params);
        if (this.mode === "error") {
          ws.send(JSON.stringify({ id: m.id, error: { code: -32000, message: "thread busy" } }));
          return;
        }
        if (this.mode === "drop-unrecorded") {
          ws.close();
          return;
        }
        const turn = { id: `turn-${this.turns.length}`, status: "inProgress", items: [{ type: "userMessage", id: "u", content: m.params.input }] };
        this.turns.push(turn);
        if (this.completeAfterMs !== null) {
          const delay = this.completeAfterMs;
          setTimeout(() => this.complete(turn.id), delay);
        }
        if (this.mode === "drop") {
          ws.close();
          return;
        }
        if (this.mode === "hang") return;
        if (this.foreignFirst) {
          ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-other", turn: { id: turn.id, status: "completed" } } }));
          ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: this.threadId, turn: { id: "turn-foreign", status: "completed" } } }));
        }
        return reply({ turn: { id: turn.id, status: "inProgress", items: [] } });
      }
      default:
        ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } }));
    }
  }
}
