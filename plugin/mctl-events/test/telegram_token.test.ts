// Self-renewal of the Telegram hydration worker token (mctlhq/mctl-claude-remote#82).
// Ported from events/tests/test_telegram_token.py: a local HTTP server stands
// in for mctl-telegram's renew endpoint and for the Pushgateway.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "bun:test";

import * as tt from "../src/telegram_token.ts";
import { TELEGRAM_TOKEN_TS } from "./support.ts";

const DAY = 24 * 3600;
const NOW = 1_800_000_000;

function jwt(exp: number, iat?: number, origIat?: number, jti = "j1"): string {
  const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const claims: Record<string, unknown> = { exp, jti, aud: ["mcp-worker-ro"] };
  if (iat !== undefined) claims.iat = iat;
  if (origIat !== undefined) claims.orig_iat = origIat;
  return `${enc({ alg: "HS256" })}.${enc(claims)}.c2ln`;
}

type Recorded = [method: string, path: string, headers: http.IncomingHttpHeaders, body: Buffer];

/** Answers the renew endpoint with a canned response and records every request. */
class FakeServer {
  readonly requests: Recorded[] = [];
  status = 200;
  body: unknown = {};
  url = "";
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      this.requests.push([req.method!, req.url!, req.headers, Buffer.concat(chunks)]);
      const payload = Buffer.from(JSON.stringify(req.method === "POST" ? this.body : {}));
      res.writeHead(req.method === "POST" ? this.status : 200, {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      });
      res.end(payload);
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  renewCalls(): Recorded[] {
    return this.requests.filter((r) => r[0] === "POST");
  }

  metrics(): Record<string, number> {
    const puts = this.requests.filter((r) => r[0] === "PUT");
    const out: Record<string, number> = {};
    if (!puts.length) return out;
    for (const line of puts.at(-1)![3].toString().split("\n")) {
      if (line && !line.startsWith("#")) {
        const [k, v] = line.split(" ");
        out[k!.replace(/^mctl_claude_remote_telegram_token_/, "")] = Number(v);
      }
    }
    return out;
  }
}

/** A server that sends a status line, promises a body, and hangs up before it. */
async function truncatingServer(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      sock.end(`HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"worker`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let dir: string;
let seed: string;
let state: string;
let served: string;
let server: FakeServer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-token-"));
  seed = path.join(dir, "seed");
  state = path.join(dir, "state", "telegram-worker-token");
  served = path.join(dir, "served");
  server = new FakeServer();
  await server.start();
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const cliArgs = (...extra: string[]): string[] => ["--seed", seed, "--state", state, "--served", served, ...extra];

function renew(now = NOW, overrides: Partial<tt.Args> = {}): Promise<number> {
  return tt.renew(
    {
      cmd: "renew",
      seed,
      state,
      served,
      mcp_url: server.url + "/mcp",
      pushgateway: server.url,
      recycle_before: 2 * DAY,
      instance: "dev-1",
      ...overrides,
    },
    now,
  );
}

const mkState = (): void => void fs.mkdirSync(path.dirname(state), { recursive: true });

describe("parse", () => {
  test("reads timing claims", () => {
    const t = tt.parse(jwt(NOW + DAY, NOW - DAY, NOW - 10 * DAY) + "\n")!;
    assert.deepEqual([t.exp, t.iat, t.orig_iat, t.jti], [NOW + DAY, NOW - DAY, NOW - 10 * DAY, "j1"]);
  });

  test("the chain anchors to iat when orig_iat is absent", () => {
    // Tokens minted before orig_iat existed: the server anchors to iat too.
    assert.equal(tt.parse(jwt(NOW + DAY, NOW - DAY))!.orig_iat, NOW - DAY);
  });

  test("rejects what is not a JWT with exp", () => {
    for (const raw of ["", "abc", "a.b", "a.!!.c", jwt(NOW).replace(".", "..")]) assert.equal(tt.parse(raw), null, raw);
    const noExp = jwt(NOW).split(".");
    noExp[1] = Buffer.from('{"iat": 1}').toString("base64url");
    assert.equal(tt.parse(noExp.join(".")), null);
    const boolExp = jwt(NOW).split(".");
    boolExp[1] = Buffer.from('{"exp": true}').toString("base64url");
    assert.equal(tt.parse(boolExp.join(".")), null);
  });
});

describe("current", () => {
  test("a newer chain wins over a later-expiring older one", () => {
    // The state holds a renewal of the old chain that outlives the fresh human
    // mint; the mint must still take over at once.
    fs.writeFileSync(seed, jwt(NOW + 20 * DAY, NOW, undefined, "new"));
    mkState();
    fs.writeFileSync(state, jwt(NOW + 25 * DAY, NOW - 5 * DAY, NOW - 100 * DAY, "old"));
    assert.equal(tt.current(seed, state)!.jti, "new");
  });

  test("within a chain the later expiry wins", () => {
    fs.writeFileSync(seed, jwt(NOW + 5 * DAY, NOW - 25 * DAY, undefined, "seed"));
    mkState();
    fs.writeFileSync(state, jwt(NOW + 30 * DAY, NOW, NOW - 25 * DAY, "state"));
    assert.equal(tt.current(seed, state)!.jti, "state");
  });

  test("an unparseable seed is ignored, not fatal", () => {
    fs.writeFileSync(seed, "not a token");
    mkState();
    fs.writeFileSync(state, jwt(NOW + DAY, NOW, undefined, "state"));
    assert.equal(tt.current(seed, state)!.jti, "state");
  });

  test("a seed that is not UTF-8 is ignored, not fatal", () => {
    fs.writeFileSync(seed, Buffer.from([0xff, 0xfe, 0x00, ...Buffer.from("garbage")]));
    mkState();
    fs.writeFileSync(state, jwt(NOW + DAY, NOW, undefined, "state"));
    assert.equal(tt.current(seed, state)!.jti, "state");
  });

  test("no token at all", () => {
    assert.equal(tt.current(seed, state), null);
  });
});

describe("renew", () => {
  test("not due makes no call", async () => {
    fs.writeFileSync(seed, jwt(NOW + 20 * DAY, NOW - 10 * DAY));
    assert.equal(await renew(), tt.OK);
    assert.deepEqual(server.renewCalls(), []);
    assert.ok(!fs.existsSync(state));
    const m = server.metrics();
    assert.equal(m.expires_in_seconds, 20 * DAY);
    assert.equal(m.chain_expires_in_seconds, 355 * DAY);
    assert.ok(!("renew_ok" in m));
  });

  test("due renews and keeps the result", async () => {
    const old = jwt(NOW + 9 * DAY, NOW - 21 * DAY);
    const fresh = jwt(NOW + 30 * DAY, NOW, NOW - 21 * DAY);
    fs.writeFileSync(seed, old);
    server.body = { worker_token: fresh, expires_at: "x" };
    assert.equal(await renew(), tt.OK);
    const calls = server.renewCalls();
    assert.equal(calls.length, 1);
    const [, reqPath, headers, body] = calls[0]!;
    assert.equal(reqPath, "/api/mcp/worker-token/renew");
    assert.equal(headers.authorization, `Bearer ${old}`);
    assert.equal(body.length, 0);
    assert.equal(fs.readFileSync(state, "utf8").trim(), fresh);
    assert.equal(fs.statSync(state).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(state)).mode & 0o777, 0o700);
    assert.equal(tt.current(seed, state)!.raw, fresh);
    const m = server.metrics();
    assert.equal(m.renew_ok, 1);
    assert.equal(m.expires_in_seconds, 30 * DAY);
    assert.deepEqual(fs.readdirSync(path.dirname(state)), ["telegram-worker-token"]); // no temp file left behind
  });

  test("a refused renewal keeps the current token", async () => {
    fs.writeFileSync(seed, jwt(NOW + DAY, NOW - 29 * DAY));
    server.status = 403;
    server.body = { error: "renewal window exhausted" };
    assert.equal(await renew(), tt.FAILED);
    assert.ok(!fs.existsSync(state));
    assert.equal(server.metrics().renew_ok, 0);
    assert.equal(server.metrics().expires_in_seconds, DAY);
  });

  test("a renewal that does not extend is a failure", async () => {
    const old = jwt(NOW + DAY, NOW - 29 * DAY);
    fs.writeFileSync(seed, old);
    server.body = { worker_token: old };
    assert.equal(await renew(), tt.FAILED);
    assert.ok(!fs.existsSync(state));
  });

  test("a response without a string worker_token is a failure", async () => {
    fs.writeFileSync(seed, jwt(NOW + DAY, NOW - 29 * DAY));
    server.body = { worker_token: 42 };
    assert.equal(await renew(), tt.FAILED);
    assert.equal(server.metrics().renew_ok, 0);
  });

  test("an expired token is not sent", async () => {
    fs.writeFileSync(seed, jwt(NOW - 1, NOW - 30 * DAY));
    assert.equal(await renew(), tt.FAILED);
    assert.deepEqual(server.renewCalls(), []);
    assert.ok(server.metrics().expires_in_seconds! < 0);
  });

  test("a renewal that cannot be kept fails open and still reports", async () => {
    fs.writeFileSync(seed, jwt(NOW + DAY, NOW - 29 * DAY));
    server.body = { worker_token: jwt(NOW + 30 * DAY, NOW, NOW - 29 * DAY) };
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "");
    assert.equal(await renew(NOW, { state: path.join(blocker, "telegram-worker-token") }), tt.FAILED);
    const m = server.metrics();
    assert.equal(m.renew_ok, 0);
    assert.equal(m.expires_in_seconds, DAY);
  });

  test("an unreadable error body is a failed renewal", async () => {
    fs.writeFileSync(seed, jwt(NOW + DAY, NOW - 29 * DAY));
    const broken = await truncatingServer(502);
    try {
      assert.equal(await renew(NOW, { mcp_url: broken.url + "/mcp", pushgateway: "" }), tt.FAILED);
    } finally {
      await broken.close();
    }
  });

  test("a truncated response is a failed renewal", async () => {
    fs.writeFileSync(seed, jwt(NOW + DAY, NOW - 29 * DAY));
    const broken = await truncatingServer(200);
    try {
      assert.equal(await renew(NOW, { mcp_url: broken.url + "/mcp", pushgateway: "" }), tt.FAILED);
      assert.ok(!fs.existsSync(state));
    } finally {
      await broken.close();
    }
  });

  test("an unreachable server is a failed renewal", async () => {
    fs.writeFileSync(seed, jwt(NOW + DAY, NOW - 29 * DAY));
    assert.equal(await renew(NOW, { mcp_url: "http://127.0.0.1:1/mcp", pushgateway: "" }), tt.FAILED);
  });

  test("metrics are grouped per device", async () => {
    fs.writeFileSync(seed, jwt(NOW + 20 * DAY, NOW - 10 * DAY));
    await renew(NOW, { instance: "dev 1/x" });
    const puts = server.requests.filter((r) => r[0] === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]![1], "/metrics/job/claude-remote-telegram-token/instance/dev%201%2Fx");
    assert.equal(puts[0]![2]["content-type"], "text/plain; version=0.0.4");
  });

  test("no token reports without the token gauges", async () => {
    assert.equal(await renew(), tt.FAILED);
    const m = server.metrics();
    assert.ok(!("expires_in_seconds" in m));
    assert.ok("last_check_timestamp_seconds" in m);
  });
});

describe("recycle", () => {
  beforeEach(() => {
    mkState();
    fs.writeFileSync(state, jwt(NOW + 25 * DAY, NOW - 5 * DAY, NOW - 40 * DAY));
  });

  test("a session on an expiring token is relaunched", async () => {
    fs.writeFileSync(served, `${NOW + DAY}\n`);
    assert.equal(await renew(), tt.RECYCLE);
  });

  test("a session on a token with time left is left alone", async () => {
    fs.writeFileSync(served, `${NOW + 3 * DAY}\n`);
    assert.equal(await renew(), tt.OK);
  });

  test("a failed renewal still relaunches onto the newer token", async () => {
    // The state holds a token from an earlier renewal; this check's renewal
    // fails, but the session must still move onto it.
    fs.writeFileSync(state, jwt(NOW + 9 * DAY, NOW - 21 * DAY, NOW - 40 * DAY));
    fs.writeFileSync(served, `${NOW + DAY}\n`);
    server.status = 503;
    assert.equal(await renew(), tt.RECYCLE);
    assert.equal(server.metrics().renew_ok, 0);
  });

  test("never relaunches onto an expired token", async () => {
    fs.writeFileSync(state, jwt(NOW - 1, NOW - 30 * DAY, NOW - 40 * DAY));
    fs.writeFileSync(served, `${NOW - 100}\n`);
    assert.equal(await renew(), tt.FAILED);
  });

  test("no newer token means no relaunch", async () => {
    // The session already holds the newest token, and renewing it fails:
    // relaunching would reconnect with the same token, so it must not.
    fs.writeFileSync(served, `${NOW + 25 * DAY}\n`);
    server.status = 503;
    assert.equal(await renew(NOW + 24 * DAY), tt.FAILED);
  });

  test("nothing served yet means no relaunch", async () => {
    assert.equal(await renew(), tt.OK);
  });

  test("reports the expiry of the token the session holds", async () => {
    fs.writeFileSync(served, `${NOW + DAY}\n`);
    await renew();
    assert.equal(server.metrics().served_expires_in_seconds, DAY);
    // After the one relaunch the guard stays quiet, but the gauge does not.
    assert.equal(await renew(NOW + 3600), tt.OK);
    assert.equal(server.metrics().served_expires_in_seconds, DAY - 3600);
  });

  test("relaunches once per served token", async () => {
    // The relaunched session did not rewrite the served file: a second
    // relaunch an hour later would change nothing but lose work.
    fs.writeFileSync(served, `${NOW + DAY}\n`);
    assert.equal(await renew(), tt.RECYCLE);
    assert.equal(fs.readFileSync(served + ".recycled", "utf8"), `${NOW + DAY}\n`);
    assert.equal(await renew(NOW + 3600), tt.OK);
    fs.writeFileSync(served, `${NOW + DAY + 1}\n`);
    assert.equal(await renew(NOW + 7200), tt.RECYCLE);
  });

  test("a broken pushgateway URL keeps the relaunch", async () => {
    fs.writeFileSync(served, `${NOW + DAY}\n`);
    assert.equal(await renew(NOW, { pushgateway: "pushgateway.monitoring.svc" }), tt.RECYCLE);
  });
});

describe("header and command line", () => {
  // As headersHelper runs it: by path, from an unrelated directory.
  const runHeader = () =>
    spawnSync(process.execPath, [TELEGRAM_TOKEN_TS, "header", ...cliArgs()], { cwd: dir, encoding: "utf8", timeout: 30_000 });

  test("prints the current token and records its expiry", () => {
    const tok = jwt(NOW + 30 * DAY, NOW);
    fs.writeFileSync(seed, tok + "\n");
    const proc = runHeader();
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.stdout, `{"Authorization": "Bearer ${tok}"}\n`);
    assert.equal(fs.readFileSync(served, "utf8").trim(), String(NOW + 30 * DAY));
  });

  test("no token prints nothing", () => {
    const proc = runHeader();
    assert.equal(proc.status, tt.FAILED);
    assert.equal(proc.stdout, "");
  });

  test("an unexpected error fails the check instead of crashing", async () => {
    fs.writeFileSync(seed, jwt(NOW + 25 * DAY, NOW - 5 * DAY));
    fs.writeFileSync(served, "-1000000000000000000000000000000\n"); // out of range for a date
    assert.equal(await tt.main(["renew", ...cliArgs(), "--mcp-url", "https://x/mcp"]), tt.FAILED);
  });

  test("the CLI refuses a plain-http MCP URL", async () => {
    assert.equal(await tt.main(["renew", ...cliArgs(), "--mcp-url", "http://x/mcp"]), tt.FAILED);
  });

  test("argparse's flags, forms and exit codes", async () => {
    const run = (...argv: string[]) => spawnSync(process.execPath, [TELEGRAM_TOKEN_TS, ...argv], { cwd: dir, encoding: "utf8" });
    assert.equal(run().status, tt.USAGE);
    assert.equal(run("nope").status, tt.USAGE);
    assert.equal(run("header", "--seed", seed).status, tt.USAGE); // --state is required
    assert.equal(run("renew", "--seed", seed, "--state", state).status, tt.USAGE); // --mcp-url is required
    assert.equal(run("header", "--seed", seed, "--state", state, "--mcp-url", "https://x").status, tt.USAGE);
    assert.equal(run("renew", ...cliArgs(), "--mcp-url", "https://x", "--recycle-before", "soon").status, tt.USAGE);
    assert.equal(run("--help").status, tt.OK);
    assert.equal(run("renew", "--help").status, tt.OK);

    const tok = jwt(NOW + 30 * DAY, NOW);
    fs.writeFileSync(seed, tok);
    const proc = run("header", `--seed=${seed}`, `--state=${state}`);
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(JSON.parse(proc.stdout).Authorization, `Bearer ${tok}`);
    const full = tt.parseArgs(["renew", ...cliArgs(), "--mcp-url", "https://x", "--recycle-before", "60", "--instance", "mac-mini-events"]) as tt.Args;
    assert.deepEqual([full.served, full.recycle_before, full.instance], [served, 60, "mac-mini-events"]);
    const parsed = tt.parseArgs(["renew", "--seed", seed, "--state", state, "--mcp-url", "https://x"]) as tt.Args;
    assert.deepEqual(
      [parsed.served, parsed.pushgateway, parsed.instance, parsed.recycle_before],
      [null, "", "claude-remote", 2 * DAY],
    );
  });
});
