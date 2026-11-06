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
  reads = 0;
  mode: StartMode = "ok";
  /** Complete every started turn after this many ms; null leaves it to the test. */
  completeAfterMs: number | null = 30;
  /** Send a turn/completed for another thread and another turn first. */
  foreignFirst = true;
  /** thread/turns/list answers without `data`: an unreadable history. */
  brokenRead = false;
  /** thread/turns/list fails from this page on (0-based); null never. */
  brokenPage: number | null = null;
  /** thread/read answers without a status: the thread's state cannot be observed. */
  brokenStatus = false;
  /** thread/read answers with a JSON-RPC error. */
  failStatus = false;
  /** Page size of thread/turns/list when the caller asks for more. */
  pageLimit = 20;
  /** The cursor of every thread/turns/list call, null for a first page. */
  cursors: Array<string | null> = [];
  /** thread/read calls without turns (status checks). */
  statusReads = 0;
  /** Agent message added to every turn this server starts; null adds none. */
  replyText: string | null = null;
  /** activeFlags of a busy thread. */
  activeFlags: string[] = [];
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

  /** A turn the operator started by hand from the ChatGPT app: the app's own client id. */
  manualTurn(text: string, status: string | null = "completed"): void {
    const n = this.turns.length;
    this.turns.push(this.turn(`turn-manual-${n}`, status, [this.userMessage(text, `app-${n}`)]));
  }

  /** A turn a waker started (before a crash, say): its client id is the wake id. */
  wakeTurn(wakeId: string, status: string | null = "completed"): string {
    const id = `turn-wake-${this.turns.length}`;
    this.turns.push(this.turn(id, status, [this.userMessage(`[wake:${wakeId}] ...`, wakeId)]));
    return id;
  }

  /** A finished turn with its messages and any other items, such as tool calls. */
  addTurn(user: string, clientId: string | null, agent: string[], extra: any[] = []): string {
    const id = `turn-added-${this.turns.length}`;
    const replies = agent.map((text, i) => ({ type: "agentMessage", id: `a-${i}`, text }));
    this.turns.push(this.turn(id, "completed", [this.userMessage(user, clientId), ...extra, ...replies]));
    return id;
  }

  private turn(id: string, status: string | null, items: any[]): any {
    return { id, status, items, itemsView: "full", startedAt: Math.floor(Date.now() / 1000) };
  }

  private userMessage(text: string, clientId: string | null): any {
    return { type: "userMessage", id: `u-${Math.random()}`, clientId, content: [{ type: "text", text }] };
  }

  get active(): any | undefined {
    return this.turns.find((t) => t.status === "inProgress");
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
        // Metadata only: the waker reads turns through thread/turns/list.
        this.statusReads++;
        if (this.failStatus) {
          ws.send(JSON.stringify({ id: m.id, error: { code: -32603, message: "thread not loaded" } }));
          return;
        }
        if (this.brokenStatus) return reply({ thread: { id: this.threadId } });
        return reply({ thread: { id: this.threadId, status: this.active ? { type: "active", activeFlags: this.activeFlags } : { type: "idle" }, turns: [] } });
      case "thread/turns/list": {
        const page = this.reads++;
        this.cursors.push(m.params.cursor ?? null);
        if (this.brokenRead || (this.brokenPage !== null && page >= this.brokenPage)) return reply({ nextCursor: null });
        const desc = [...this.turns].reverse();
        const from = m.params.cursor ? Number(m.params.cursor) : 0;
        const n = Math.min(m.params.limit ?? this.pageLimit, this.pageLimit);
        const data = desc.slice(from, from + n);
        return reply({ data, nextCursor: from + n < desc.length ? String(from + n) : null, backwardsCursor: null });
      }
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
        const msg = this.userMessage(m.params.input?.[0]?.text ?? "", m.params.clientUserMessageId ?? null);
        // A busy thread does not refuse: the input joins the running turn (seen live, Codex 0.163).
        const running = this.active;
        if (running) {
          running.items.push(msg);
          return reply({ turn: { id: running.id, status: "inProgress", items: [], itemsView: "notLoaded" } });
        }
        const items: any[] = [msg];
        if (this.replyText !== null) items.push({ type: "agentMessage", id: "a-0", text: this.replyText });
        const turn = this.turn(`turn-${this.turns.length}`, "inProgress", items);
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
        return reply({ turn: { id: turn.id, status: "inProgress", items: [], itemsView: "notLoaded" } });
      }
      default:
        ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } }));
    }
  }
}
