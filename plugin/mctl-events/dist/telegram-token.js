// The read-only mctl-telegram worker token used to hydrate telegram.message.*
// events. A port of events/mctl_events/telegram_token.py with the same command
// line, files and exit codes (mctlhq/mctl-claude-remote#82).
//
// Two token sources are kept, and the one from the newer chain wins:
//
//   - the seed: a file the operator controls (Vault -> ExternalSecret). A human
//     mint is written here, so re-minting needs no access to the device;
//   - the state file: renewals this device made itself.
//
// `renew` exchanges the current token for a fresh one through mctl-telegram's
// POST /api/mcp/worker-token/renew once less than a third of its lifetime is
// left. The server copies identity and scopes from the presented token and
// caps the chain at a year from the human mint, so nothing here can widen what
// the credential grants or keep it alive forever.
//
// `header` is the MCP server's headersHelper: Claude Code runs it when it
// connects, so a renewed token is used on the next connection without a
// restart. It records the expiry of the token it handed out; `renew` exits
// with RECYCLE when that token is about to lapse while a newer one is
// available, and the caller then relaunches the session.
//
// Renewal is fail-open: a failed attempt keeps the current token, which is
// still valid because renewal starts with a third of the lifetime left, and
// reports through the Pushgateway metrics, which alert long before expiry.
//
// No dependencies: headersHelper starts it by path from whatever working
// directory Claude Code chooses.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, isoSeconds, pyJson, pyQuote, pyStrRepr } from "./util.js";
// Mirrors mctl-telegram's workertoken.maxRenewalChain. Used only to report how
// long the chain has left; the server enforces the real limit.
export const MAX_RENEWAL_CHAIN_S = 365 * 24 * 3600;
// Renew once remaining lifetime falls below lifetime / RENEW_AT_FRACTION, the
// same rule as the mctl-telegram canary.
export const RENEW_AT_FRACTION = 3;
// Exit codes of `renew`.
export const OK = 0;
export const FAILED = 1;
export const RECYCLE = 10;
/** argparse's exit code for a command line it cannot parse. */
export const USAGE = 2;
export function chainDeadline(token) {
    return token.orig_iat + MAX_RENEWAL_CHAIN_S;
}
/**
 * A newer chain beats an older one even when the older one's latest renewal
 * expires later: a human re-mint usually means the old chain was revoked or
 * is ending, and must take over at once.
 */
function outranks(a, b) {
    return a.orig_iat !== b.orig_iat ? a.orig_iat > b.orig_iat : a.exp > b.exp;
}
const isInt = (value) => typeof value === "number" && Number.isInteger(value);
const utf8 = new TextDecoder("utf-8", { fatal: true });
/**
 * Read a JWT's timing claims without verifying it: the server verifies, this
 * only decides when to renew. Null for anything that is not a JWT with an
 * integer exp.
 */
export function parse(input) {
    const raw = input.trim();
    const parts = raw.split(".");
    if (parts.length !== 3 || !parts[1])
        return null;
    let body;
    try {
        // Like Python's non-strict b64decode, characters outside the alphabet are
        // skipped rather than rejected.
        body = JSON.parse(utf8.decode(Buffer.from(parts[1], "base64url")));
    }
    catch {
        return null;
    }
    if (!isObject(body))
        return null;
    const exp = body.exp;
    if (!isInt(exp))
        return null;
    const iat = isInt(body.iat) ? body.iat : exp - 30 * 24 * 3600;
    const orig = isInt(body.orig_iat) && body.orig_iat > 0 ? body.orig_iat : iat;
    const jti = typeof body.jti === "string" ? body.jti : "";
    return { raw, exp, iat, orig_iat: orig, jti };
}
export function log(msg) {
    process.stderr.write(`[telegram-token] ${msg}\n`);
}
function errorText(exc) {
    return exc instanceof Error ? exc.message : String(exc);
}
export function readToken(file) {
    if (file === null)
        return null;
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    }
    catch (exc) {
        if (exc.code === "ENOENT")
            return null;
        log(`WARN cannot read ${file}: ${errorText(exc)}`);
        return null;
    }
    let text;
    try {
        text = utf8.decode(bytes);
    }
    catch {
        // Not UTF-8, so not a JWT: treat it like any other unparseable file, so
        // the other source can still win.
        log(`WARN ${file} is not UTF-8 text; ignoring it`);
        return null;
    }
    const token = parse(text);
    if (token === null && text.trim())
        log(`WARN ${file} does not hold a JWT with an exp claim; ignoring it`);
    return token;
}
export function current(seed, state) {
    let best = null;
    for (const token of [readToken(seed), readToken(state)]) {
        if (token !== null && (best === null || outranks(token, best)))
            best = token;
    }
    return best;
}
/** `Path.mkdir(parents=True, exist_ok=True, mode=0o700)`: only the leaf gets the mode. */
function makeParents(dir) {
    const missing = [];
    let at = path.resolve(dir);
    while (!fs.existsSync(at)) {
        missing.unshift(at);
        const up = path.dirname(at);
        if (up === at)
            break;
        at = up;
    }
    missing.forEach((name, index) => {
        try {
            fs.mkdirSync(name, { mode: index === missing.length - 1 ? 0o700 : 0o777 });
        }
        catch (exc) {
            if (exc.code !== "EEXIST")
                throw exc;
        }
    });
    if (!fs.statSync(dir).isDirectory()) {
        throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${dir}'`), { code: "EEXIST" });
    }
}
export function writeAtomic(file, text) {
    const dir = path.dirname(file);
    makeParents(dir);
    const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("base64url")}.tmp`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
        try {
            fs.writeFileSync(fd, text, "utf8");
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    }
    catch (exc) {
        try {
            fs.unlinkSync(tmp);
        }
        catch {
            // already gone
        }
        throw exc;
    }
}
export function renewUrl(mcpUrl) {
    const u = new URL(mcpUrl);
    const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
    return `${u.protocol}//${auth}${u.host}/api/mcp/worker-token/renew`;
}
/** A failed renewal; the current token is kept. */
export class RenewError extends Error {
    name = "RenewError";
}
/**
 * One HTTP request without following redirects. Resolves once the status line
 * and up to `limit` bytes of body are in; rejects only when no response
 * arrived at all.
 */
function request(url, method, headers, payload, timeoutSeconds, limit) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            reject(new Error(`unknown url type: ${pyStrRepr(url)}`));
            return;
        }
        const client = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : null;
        if (client === null) {
            reject(new Error(`unknown url type: ${pyStrRepr(parsed.protocol.replace(/:$/, ""))}`));
            return;
        }
        const req = client.request(parsed, { method, headers, timeout: timeoutSeconds * 1000 }, (res) => {
            const chunks = [];
            let size = 0;
            let settled = false;
            const finish = (complete) => {
                if (settled)
                    return;
                settled = true;
                const body = Buffer.concat(chunks).subarray(0, limit);
                resolve({ status: res.statusCode ?? 0, reason: res.statusMessage ?? "", body: complete ? body : null });
                res.destroy();
            };
            res.on("data", (chunk) => {
                chunks.push(chunk);
                size += chunk.length;
                if (size >= limit)
                    finish(true);
            });
            res.on("end", () => finish(true));
            res.on("aborted", () => finish(false));
            res.on("error", () => finish(false));
            res.on("close", () => finish(res.complete));
        });
        req.on("timeout", () => req.destroy(new Error("timed out")));
        req.on("error", reject);
        req.end(payload);
    });
}
export async function callRenew(url, token, timeout = 30.0) {
    let res;
    try {
        res = await request(url, "POST", { Authorization: `Bearer ${token.raw}`, "Content-Length": "0" }, Buffer.alloc(0), timeout, 65536);
    }
    catch (exc) {
        throw new RenewError(`request failed: ${errorText(exc)}`);
    }
    if (res.status < 200 || res.status >= 300) {
        // The error body is a short JSON message from the server, never a token.
        const detail = res.body === null ? "<error body unreadable>" : res.body.subarray(0, 512).toString("utf8").trim();
        throw new RenewError(`HTTP ${res.status}: ${detail}`);
    }
    if (res.body === null)
        throw new RenewError("request failed: response body was cut short");
    let body;
    try {
        body = JSON.parse(utf8.decode(res.body));
    }
    catch (exc) {
        throw new RenewError(`request failed: ${errorText(exc)}`);
    }
    const value = isObject(body) && Object.hasOwn(body, "worker_token") ? body.worker_token : "";
    const renewed = typeof value === "string" ? parse(value) : null;
    if (renewed === null)
        throw new RenewError("response carried no parseable worker_token");
    if (renewed.exp <= token.exp)
        throw new RenewError("renewed token does not outlive the current one");
    return renewed;
}
/**
 * PUT the gauges for this device's group to the Pushgateway, replacing its
 * previous push. A gauge is omitted, not zeroed, when it cannot be computed: a
 * 0 would read as "already expired". Never throws: a broken push must not
 * swallow the exit code that tells the caller to relaunch the session.
 */
export async function pushMetrics(url, instance, token, renewOk, served, now) {
    const lines = [];
    if (token !== null) {
        lines.push("# TYPE mctl_claude_remote_telegram_token_expires_in_seconds gauge", `mctl_claude_remote_telegram_token_expires_in_seconds ${token.exp - now}`, "# TYPE mctl_claude_remote_telegram_token_chain_expires_in_seconds gauge", `mctl_claude_remote_telegram_token_chain_expires_in_seconds ${chainDeadline(token) - now}`);
    }
    if (served !== null) {
        // The token the session actually connected with, which can lag the newest
        // one on disk until the session reconnects.
        lines.push("# TYPE mctl_claude_remote_telegram_token_served_expires_in_seconds gauge", `mctl_claude_remote_telegram_token_served_expires_in_seconds ${served - now}`);
    }
    if (renewOk !== null) {
        lines.push("# TYPE mctl_claude_remote_telegram_token_renew_ok gauge", `mctl_claude_remote_telegram_token_renew_ok ${renewOk}`);
    }
    lines.push("# TYPE mctl_claude_remote_telegram_token_last_check_timestamp_seconds gauge", `mctl_claude_remote_telegram_token_last_check_timestamp_seconds ${now}`);
    // One group per device, so two devices on one Pushgateway cannot overwrite
    // each other's gauges.
    const target = url.replace(/\/+$/, "") + "/metrics/job/claude-remote-telegram-token/instance/" + pyQuote(instance);
    try {
        const res = await request(target, "PUT", { "Content-Type": "text/plain; version=0.0.4" }, Buffer.from(lines.join("\n") + "\n"), 10, 65536);
        if (res.status < 200 || res.status >= 300)
            throw new Error(`HTTP Error ${res.status}: ${res.reason}`);
    }
    catch (exc) {
        log(`WARN metrics push failed: ${errorText(exc)}`);
    }
}
export function iso(ts) {
    return isoSeconds(ts);
}
export function readServed(file) {
    if (file === null)
        return null;
    try {
        const text = utf8.decode(fs.readFileSync(file)).trim();
        // `int()`: an optional sign, digits, and single underscores between them.
        if (!/^[+-]?\d+(?:_\d+)*$/.test(text))
            return null;
        return Number(text.replace(/_/g, ""));
    }
    catch {
        return null;
    }
}
/**
 * RECYCLE at most once per served token. A relaunched session rewrites the
 * served file on connect; if it stays the same, either the session did not
 * reconnect or the header could not record it, and relaunching again every
 * hour would only throw away in-flight work.
 */
export function recycleOnce(servedPath, served, token) {
    const marker = servedPath + ".recycled";
    if (readServed(marker) === served) {
        log(`WARN session still reports a token expiring ${iso(served)} after a relaunch; not relaunching again`);
        return OK;
    }
    try {
        writeAtomic(marker, `${served}\n`);
    }
    catch (exc) {
        log(`WARN cannot record the relaunch, so not relaunching: ${errorText(exc)}`);
        return OK;
    }
    log(`session connected with a token expiring ${iso(served)}; a newer one expires ` +
        `${iso(token.exp)}: relaunch the session to reconnect`);
    return RECYCLE;
}
export async function renew(args, now = Math.floor(Date.now() / 1000)) {
    let token = current(args.seed, args.state);
    let renewOk = null;
    let rc = OK;
    if (token === null) {
        log("ERROR no readable worker token in the seed or the state file");
        rc = FAILED;
    }
    else if (token.exp <= now) {
        log(`ERROR worker token expired at ${iso(token.exp)}; an administrator must mint a new one ` +
            "and write it to the seed (Vault)");
        rc = FAILED;
    }
    else if (token.exp - now < Math.floor(Math.max(token.exp - token.iat, 1) / RENEW_AT_FRACTION)) {
        let renewed = null;
        try {
            renewed = await callRenew(renewUrl(args.mcp_url), token);
        }
        catch (exc) {
            if (!(exc instanceof RenewError))
                throw exc;
            log(`WARN renewal failed, keeping the current token (expires ${iso(token.exp)}): ${exc.message}`);
            renewOk = 0;
            rc = FAILED;
        }
        if (renewed !== null) {
            try {
                writeAtomic(args.state, renewed.raw + "\n");
                log(`renewed jti=${renewed.jti || "-"} expires=${iso(renewed.exp)} chain_ends=${iso(chainDeadline(renewed))}`);
                token = renewed;
                renewOk = 1;
            }
            catch (exc) {
                // The server has issued the token, but without the state file nothing
                // would use it; the current one is still valid.
                log(`ERROR renewed jti=${renewed.jti || "-"} but cannot keep it, keeping the current ` +
                    `token (expires ${iso(token.exp)}): ${errorText(exc)}`);
                renewOk = 0;
                rc = FAILED;
            }
        }
    }
    // Independent of this check's renewal: a newer token already on disk is
    // worth reconnecting to even when renewing it just failed. Never onto an
    // expired one.
    const served = readServed(args.served);
    if (token !== null && served !== null && now < token.exp) {
        if (token.exp > served && served - now < args.recycle_before) {
            if (recycleOnce(args.served, served, token) === RECYCLE)
                rc = RECYCLE;
        }
    }
    if (args.pushgateway)
        await pushMetrics(args.pushgateway, args.instance, token, renewOk, served, now);
    return rc;
}
export function header(args) {
    const token = current(args.seed, args.state);
    if (token === null) {
        log("ERROR no readable worker token in the seed or the state file");
        return FAILED;
    }
    if (args.served !== null) {
        try {
            writeAtomic(args.served, `${token.exp}\n`);
        }
        catch (exc) {
            log(`WARN could not record the served token's expiry: ${errorText(exc)}`);
        }
    }
    process.stdout.write(pyJson({ Authorization: `Bearer ${token.raw}` }) + "\n");
    return OK;
}
const PROG = "telegram-token";
const DESCRIPTION = "The read-only mctl-telegram worker token used to hydrate telegram.message.* events.";
class UsageError extends Error {
}
const COMMON = ["--seed", "--state", "--served"];
const RENEW_ONLY = ["--mcp-url", "--pushgateway", "--instance", "--recycle-before"];
function usage(cmd) {
    if (cmd === "header")
        return `usage: ${PROG} header [-h] --seed SEED --state STATE [--served SERVED]`;
    if (cmd === "renew") {
        return (`usage: ${PROG} renew [-h] --seed SEED --state STATE [--served SERVED] --mcp-url MCP_URL\n` +
            "       [--pushgateway PUSHGATEWAY] [--instance INSTANCE] [--recycle-before RECYCLE_BEFORE]");
    }
    return `usage: ${PROG} [-h] {header,renew} ...`;
}
function help(cmd) {
    if (cmd === null) {
        return `${usage(null)}\n\n${DESCRIPTION}\n\npositional arguments:\n  {header,renew}\n\noptions:\n  -h, --help      show this help message and exit\n`;
    }
    let text = `${usage(cmd)}\n\noptions:\n  -h, --help            show this help message and exit\n` +
        "  --seed SEED           operator-provided token file (Vault)\n" +
        "  --state STATE         where this device keeps its renewals\n" +
        "  --served SERVED       expiry of the token last handed to Claude Code\n";
    if (cmd === "renew") {
        text +=
            "  --mcp-url MCP_URL\n  --pushgateway PUSHGATEWAY\n" +
                "  --instance INSTANCE   Pushgateway instance label (the device name)\n" +
                "  --recycle-before RECYCLE_BEFORE\n" +
                "                        relaunch the session when its token has less than this many seconds left\n";
    }
    return text;
}
/** The argparse command line of the Python tool; `"help"` when help was printed. */
export function parseArgs(argv) {
    let cmd = null;
    const values = new Map();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-h" || arg === "--help") {
            process.stdout.write(help(cmd));
            return "help";
        }
        if (cmd === null) {
            if (arg === "header" || arg === "renew") {
                cmd = arg;
                continue;
            }
            if (arg.startsWith("-"))
                throw new UsageError(`unrecognized arguments: ${arg}`);
            throw new UsageError(`argument cmd: invalid choice: ${pyStrRepr(arg)} (choose from 'header', 'renew')`);
        }
        const eq = arg.indexOf("=");
        const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
        const known = COMMON.includes(flag) || (cmd === "renew" && RENEW_ONLY.includes(flag));
        if (!known)
            throw new UsageError(`unrecognized arguments: ${argv.slice(i).join(" ")}`);
        let value;
        if (flag !== arg) {
            value = arg.slice(eq + 1);
        }
        else {
            const next = argv[i + 1];
            // argparse takes a following token as the value unless it looks like an option.
            if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) {
                throw new UsageError(`argument ${flag}: expected one argument`);
            }
            value = next;
            i += 1;
        }
        values.set(flag, value);
    }
    if (cmd === null)
        throw new UsageError("the following arguments are required: cmd");
    const required = cmd === "renew" ? ["--seed", "--state", "--mcp-url"] : ["--seed", "--state"];
    const absent = required.filter((flag) => !values.has(flag));
    if (absent.length)
        throw Object.assign(new UsageError(`the following arguments are required: ${absent.join(", ")}`), { cmd });
    let recycleBefore = 2 * 24 * 3600;
    if (values.has("--recycle-before")) {
        const raw = values.get("--recycle-before");
        if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(raw)) {
            throw Object.assign(new UsageError(`argument --recycle-before: invalid int value: ${pyStrRepr(raw)}`), { cmd });
        }
        recycleBefore = Number(raw.trim().replace(/_/g, ""));
    }
    return {
        cmd,
        seed: values.get("--seed"),
        state: values.get("--state"),
        served: values.has("--served") ? values.get("--served") : null,
        mcp_url: values.get("--mcp-url") ?? "",
        pushgateway: values.get("--pushgateway") ?? "",
        instance: values.get("--instance") ?? "claude-remote",
        recycle_before: recycleBefore,
    };
}
export async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
    }
    catch (exc) {
        if (!(exc instanceof UsageError))
            throw exc;
        const cmd = exc.cmd ?? null;
        process.stderr.write(`${usage(cmd)}\n${PROG}${cmd ? ` ${cmd}` : ""}: error: ${exc.message}\n`);
        return USAGE;
    }
    if (args === "help")
        return OK;
    if (args.cmd === "renew" && !args.mcp_url.startsWith("https://")) {
        log("ERROR --mcp-url must be https");
        return FAILED;
    }
    if (args.cmd === "header")
        return header(args);
    try {
        return await renew(args);
    }
    catch (exc) {
        // The loop must never lose a tick to a stack trace.
        const name = exc instanceof Error ? exc.name : typeof exc;
        log(`ERROR renewal check failed: ${name}(${pyStrRepr(errorText(exc))})`);
        return FAILED;
    }
}
function isEntrypoint() {
    const script = process.argv[1];
    if (!script)
        return false;
    try {
        return fs.realpathSync(script) === fs.realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isEntrypoint()) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (exc) => {
        log(`ERROR ${errorText(exc)}`);
        process.exitCode = FAILED;
    });
}
