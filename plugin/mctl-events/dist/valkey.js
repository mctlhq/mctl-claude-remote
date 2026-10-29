// A deliberately small, dependency-free Valkey (RESP2) client.
//
// Only what the Streams consumer needs, ported from events/mctl_events/valkey.py.
// A pinned third-party client would be one more thing to keep patched for a
// handful of commands. Every connection runs one command at a time, in call
// order; blocking reads get a dedicated connection so they never stall
// acknowledgements.
import net from "node:net";
/** The server answered with an error reply. */
export class ValkeyError extends Error {
    name = "ValkeyError";
}
/** The connection failed or closed mid-reply. */
export class ValkeyConnectionError extends Error {
    name = "ValkeyConnectionError";
}
// Envelopes are capped at 4 KiB; no reply this client reads legitimately
// carries a longer string. A longer one is skipped on the wire, never buffered.
export const MAX_BULK_BYTES = 64 * 1024;
/** Stands in for a bulk string longer than MAX_BULK_BYTES that was discarded. */
export class Oversized {
    size;
    constructor(size) {
        this.size = size;
    }
}
/** `Endpoint.from_url`: only redis:// or valkey://, in-cluster, no TLS. */
export function endpointFromUrl(url, password = null) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error("URL could not be parsed");
    }
    if (parsed.protocol !== "redis:" && parsed.protocol !== "valkey:") {
        throw new Error("only redis:// or valkey:// URLs are supported (in-cluster, no TLS)");
    }
    let host = parsed.hostname;
    if (host.startsWith("[") && host.endsWith("]"))
        host = host.slice(1, -1);
    if (!host)
        throw new Error("URL has no host");
    const path = parsed.pathname.replace(/^\/+/, "");
    if (path && !/^\s*[+-]?\d+\s*$/.test(path))
        throw new Error(`invalid database in URL: ${path}`);
    const db = path ? Number.parseInt(path, 10) : 0;
    return {
        host: host.toLowerCase(),
        port: parsed.port ? Number(parsed.port) : 6379,
        username: parsed.username ? decodeURIComponent(parsed.username) : null,
        password: password !== null ? password : parsed.password ? decodeURIComponent(parsed.password) : null,
        db,
    };
}
export function encode(args) {
    const out = [Buffer.from(`*${args.length}\r\n`)];
    for (const arg of args) {
        let data;
        if (Buffer.isBuffer(arg))
            data = arg;
        else if (typeof arg === "string")
            data = Buffer.from(arg, "utf8");
        else if (typeof arg === "number" && Number.isFinite(arg))
            data = Buffer.from(String(arg));
        else
            throw new TypeError(`unsupported argument type ${typeof arg}`);
        out.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from("\r\n"));
    }
    return Buffer.concat(out);
}
const CRLF = Buffer.from("\r\n");
/**
 * The read side of one socket: holds at most what has arrived and not been
 * parsed yet, and pauses the socket while it does, so a reply longer than it
 * should be is skipped a chunk at a time rather than buffered whole.
 */
export class Wire {
    buf = Buffer.alloc(0);
    pending = [];
    waiter = null;
    failure = null;
    /** Called after every fill with the buffered byte count (tests). */
    onFill = null;
    socket;
    constructor(socket) {
        this.socket = socket;
        socket.on("data", (chunk) => {
            this.pending.push(chunk);
            socket.pause();
            this.wake();
        });
        socket.on("end", () => this.fail(new ValkeyConnectionError("connection closed by server")));
        socket.on("close", () => this.fail(new ValkeyConnectionError("connection closed")));
        socket.on("error", (err) => this.fail(new ValkeyConnectionError(err.message)));
    }
    fail(err) {
        if (this.failure === null)
            this.failure = err;
        this.wake();
    }
    wake() {
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.();
    }
    async fill() {
        while (!this.pending.length) {
            if (this.failure)
                throw this.failure;
            await new Promise((resolve) => {
                this.waiter = resolve;
            });
        }
        const chunk = this.pending.shift();
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        if (!this.pending.length && !this.socket.destroyed)
            this.socket.resume();
        this.onFill?.(this.buf.length);
    }
    async readLine() {
        let at;
        while ((at = this.buf.indexOf(CRLF)) < 0)
            await this.fill();
        const line = this.buf.subarray(0, at);
        this.buf = this.buf.subarray(at + 2);
        return line;
    }
    async readExact(n) {
        while (this.buf.length < n + 2)
            await this.fill();
        const data = Buffer.from(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n + 2);
        return data;
    }
    /** Discard n bytes plus CRLF without holding more than one chunk. */
    async skip(n) {
        let remaining = n + 2;
        while (remaining) {
            if (!this.buf.length)
                await this.fill();
            const take = Math.min(remaining, this.buf.length);
            this.buf = this.buf.subarray(take);
            remaining -= take;
        }
    }
    /** One reply; an error reply is returned as a ValkeyError, not thrown. */
    async readReply() {
        const line = await this.readLine();
        const kind = line.subarray(0, 1).toString("latin1");
        const rest = line.subarray(1).toString("utf8");
        if (kind === "+")
            return rest;
        if (kind === "-")
            return new ValkeyError(rest);
        if (kind === ":")
            return integer(rest);
        if (kind === "$") {
            const n = integer(rest);
            if (n < 0)
                return null;
            if (n > MAX_BULK_BYTES) {
                await this.skip(n);
                return new Oversized(n);
            }
            return this.readExact(n);
        }
        if (kind === "*") {
            const n = integer(rest);
            if (n < 0)
                return null;
            const items = [];
            for (let i = 0; i < n; i++) {
                const item = await this.readReply();
                // RESP2 can nest an error inside an array (EXEC); keep it as data.
                items.push(item instanceof ValkeyError ? item.message : item);
            }
            return items;
        }
        throw new ValkeyConnectionError(`unexpected reply type ${JSON.stringify(kind)}`);
    }
}
function integer(text) {
    if (!/^-?\d+$/.test(text))
        throw new ValkeyConnectionError(`malformed integer ${JSON.stringify(text.slice(0, 32))}`);
    return Number(text);
}
export class Connection {
    socket = null;
    wire = null;
    queue = Promise.resolve();
    /** `timeout` is in seconds, as in the Python client. */
    endpoint;
    timeout;
    constructor(endpoint, timeout = 10.0) {
        this.endpoint = endpoint;
        this.timeout = timeout;
    }
    async connect() {
        const socket = await new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: this.endpoint.host, port: this.endpoint.port });
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new ValkeyConnectionError("timed out"));
            }, this.timeout * 1000);
            sock.once("connect", () => {
                clearTimeout(timer);
                sock.removeAllListeners("error");
                resolve(sock);
            });
            sock.once("error", (err) => {
                clearTimeout(timer);
                reject(new ValkeyConnectionError(err.message));
            });
        });
        socket.setNoDelay(true);
        this.socket = socket;
        this.wire = new Wire(socket);
        try {
            if (this.endpoint.password !== null) {
                if (this.endpoint.username) {
                    await this.roundtrip(["AUTH", this.endpoint.username, this.endpoint.password], this.timeout);
                }
                else {
                    await this.roundtrip(["AUTH", this.endpoint.password], this.timeout);
                }
            }
            if (this.endpoint.db)
                await this.roundtrip(["SELECT", this.endpoint.db], this.timeout);
        }
        catch (err) {
            this.close();
            throw err;
        }
    }
    close() {
        const socket = this.socket;
        this.socket = null;
        this.wire = null;
        socket?.destroy();
    }
    /**
     * Unblock a read in progress; that call then fails with a transport error.
     * Does not wait for the queue, since the reader holds its place in it.
     */
    interrupt() {
        const wire = this.wire;
        this.socket?.destroy();
        wire?.fail(new ValkeyConnectionError("connection interrupted"));
    }
    async roundtrip(args, timeout) {
        const socket = this.socket;
        const wire = this.wire;
        let timer;
        if (timeout !== null) {
            timer = setTimeout(() => {
                wire.fail(new ValkeyConnectionError("timed out"));
                socket.destroy();
            }, timeout * 1000);
        }
        try {
            socket.write(encode(args));
            const reply = await wire.readReply();
            if (reply instanceof ValkeyError)
                throw reply;
            return reply;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    /** Run one command. A transport failure drops the socket so the next call reconnects. */
    execute(args, options = {}) {
        const run = async () => {
            try {
                if (this.socket === null)
                    await this.connect();
                return await this.roundtrip(args, options.timeout ?? this.timeout);
            }
            catch (err) {
                if (err instanceof ValkeyError)
                    throw err;
                this.close();
                if (err instanceof ValkeyConnectionError)
                    throw err;
                throw new ValkeyConnectionError(err instanceof Error ? err.message : String(err));
            }
        };
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => undefined);
        return result;
    }
}
