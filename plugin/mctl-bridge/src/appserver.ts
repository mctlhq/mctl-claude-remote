// Minimal client for the Codex app-server control socket: WebSocket over a Unix
// socket, path /rpc, JSON-RPC text frames without a `jsonrpc` field. A port of the
// gate-1 spike (docs/orchestrator-bridge-spike/wake.py), with no dependencies.

import crypto from "node:crypto";
import net from "node:net";

/** The server answered with a JSON-RPC error: the request definitely did not take effect as asked. */
export class RpcError extends Error {
  readonly code: unknown;
  constructor(method: string, error: { code?: unknown; message?: unknown }) {
    super(`${method}: ${String(error?.message ?? "error")}`);
    this.code = error?.code;
  }
}

/** The connection failed or a reply did not arrive in time: the outcome is unknown. */
export class ConnectionLost extends Error {}

export type Note = { method: string; params?: any };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string };

export class AppClient {
  private readonly sock: net.Socket;
  private buf = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(n: Note) => void>();
  private readonly closers = new Set<(e: Error) => void>();
  private closed: Error | null = null;

  private constructor(sock: net.Socket) {
    this.sock = sock;
  }

  static connect(path: string, timeoutMs = 10_000): Promise<AppClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path });
      const key = crypto.randomBytes(16).toString("base64");
      let head = Buffer.alloc(0);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new ConnectionLost("handshake timed out"));
      }, timeoutMs);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        sock.destroy();
        reject(new ConnectionLost(err.message));
      };
      sock.once("error", fail);
      const closed = (): void => fail(new Error("socket closed during the handshake"));
      sock.once("close", closed);
      sock.once("connect", () => {
        sock.write(
          "GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        sock.off("data", onData);
        sock.off("error", fail);
        sock.off("close", closed);
        clearTimeout(timer);
        const status = head.subarray(0, head.indexOf("\r\n")).toString();
        if (!/ 101 /.test(status)) {
          sock.destroy();
          reject(new ConnectionLost(`handshake failed: ${status}`));
          return;
        }
        const client = new AppClient(sock);
        client.attach(head.subarray(end + 4));
        resolve(client);
      };
      sock.on("data", onData);
    });
  }

  private attach(rest: Buffer): void {
    this.sock.on("data", (chunk: Buffer) => this.feed(chunk));
    this.sock.on("error", (err) => this.shut(new ConnectionLost(err.message)));
    this.sock.on("close", () => this.shut(new ConnectionLost("socket closed")));
    if (rest.length > 0) this.feed(rest);
  }

  private feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      let n = b1 & 0x7f;
      let at = 2;
      if (n === 126) {
        if (this.buf.length < 4) return;
        n = this.buf.readUInt16BE(2);
        at = 4;
      } else if (n === 127) {
        if (this.buf.length < 10) return;
        n = Number(this.buf.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const need = at + (masked ? 4 : 0) + n;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(at + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(at, at + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
      }
      this.buf = this.buf.subarray(need);
      const op = b0 & 0x0f;
      if (op === 0x9) this.frame(0xa, payload);
      else if (op === 0x8) this.shut(new ConnectionLost("server closed the websocket"));
      else if (op === 0x1 || op === 0x0) {
        this.parts.push(Buffer.from(payload));
        if (b0 & 0x80) {
          const text = Buffer.concat(this.parts).toString("utf8");
          this.parts = [];
          this.dispatch(text);
        }
      }
    }
  }

  private dispatch(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg && typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ("error" in msg) p.reject(new RpcError(p.method, msg.error));
      else p.resolve(msg.result);
    } else if (msg && typeof msg.method === "string" && msg.id === undefined) {
      for (const fn of this.listeners) fn({ method: msg.method, params: msg.params });
    }
    // Server-initiated requests (approvals and the like) are not ours to answer.
  }

  private frame(op: number, data: Buffer): void {
    if (this.closed) return;
    const n = data.length;
    const head: number[] = [0x80 | op];
    if (n < 126) head.push(0x80 | n);
    else if (n < 65536) head.push(0x80 | 126, (n >> 8) & 0xff, n & 0xff);
    else {
      head.push(0x80 | 127);
      const len = Buffer.alloc(8);
      len.writeBigUInt64BE(BigInt(n));
      head.push(...len);
    }
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(data.map((b, i) => b ^ mask[i % 4]!));
    this.sock.write(Buffer.concat([Buffer.from(head), mask, body]));
  }

  private shut(err: Error): void {
    if (this.closed) return;
    this.closed = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const fn of this.closers) fn(err);
    this.sock.destroy();
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  notify(method: string, params?: unknown): void {
    this.frame(0x1, Buffer.from(JSON.stringify(params === undefined ? { method } : { method, params })));
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectionLost(`${method}: no reply in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.frame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    });
  }

  onNote(fn: (n: Note) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: (e: Error) => void): () => void {
    if (this.closed) fn(this.closed);
    this.closers.add(fn);
    return () => this.closers.delete(fn);
  }

  close(): void {
    this.shut(new ConnectionLost("closed by client"));
  }
}
