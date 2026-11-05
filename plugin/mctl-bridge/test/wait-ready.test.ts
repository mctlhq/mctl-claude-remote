// A server that is still loading its dataset, or not yet listening, is an UNKNOWN state for the
// startup check, never "library absent": the clients wait, but a definite answer (no library,
// another version) or running out of time still fails.

import { describe, expect, test } from "bun:test";

import { Bridge, LIBRARY_VERSION } from "../src/store.ts";
import { ValkeyConnectionError, ValkeyError } from "../src/valkey.ts";
import type { Executor, Reply } from "../src/valkey.ts";

function scripted(steps: Array<Error | string>): { b: Bridge; calls: () => number } {
  let n = 0;
  const exec = {
    async execute(): Promise<Reply> {
      const step = steps[Math.min(n++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  } as unknown as Executor;
  return { b: new Bridge(exec), calls: () => n };
}

const loading = () => new ValkeyError("LOADING Valkey is loading the dataset in memory");

describe("startup wait for the server", () => {
  test("waits out LOADING and then succeeds", async () => {
    const { b, calls } = scripted([loading(), loading(), LIBRARY_VERSION]);
    const waits: string[] = [];
    await b.waitReady({ intervalMs: 5, timeoutMs: 5000, onWait: (r) => waits.push(r) });
    expect(calls()).toBe(3);
    expect(waits.length).toBe(2);
  });

  test("waits out a server that is not listening yet", async () => {
    const { b, calls } = scripted([new Error("connect ECONNREFUSED 127.0.0.1:6390"), new ValkeyConnectionError("connection closed by server"), LIBRARY_VERSION]);
    await b.waitReady({ intervalMs: 5, timeoutMs: 5000 });
    expect(calls()).toBe(3);
  });

  test("a missing library is a definite answer: no waiting", async () => {
    const { b, calls } = scripted([new ValkeyError("ERR Function not found"), LIBRARY_VERSION]);
    await expect(b.waitReady({ intervalMs: 5, timeoutMs: 5000 })).rejects.toThrow(/library not loaded/);
    expect(calls()).toBe(1);
  });

  test("another library version fails at once", async () => {
    const { b, calls } = scripted(["0-other", LIBRARY_VERSION]);
    await expect(b.waitReady({ intervalMs: 5, timeoutMs: 5000 })).rejects.toThrow(/library version/);
    expect(calls()).toBe(1);
  });

  test("waitServing waits out LOADING with no library loaded yet", async () => {
    const { b, calls } = scripted([loading(), loading(), "PONG"]);
    await b.waitServing({ intervalMs: 5, timeoutMs: 5000 });
    expect(calls()).toBe(3);
  });

  test("waitServing does not take a refusal for readiness", async () => {
    const { b, calls } = scripted([new ValkeyError("NOAUTH Authentication required")]);
    await expect(b.waitServing({ intervalMs: 5, timeoutMs: 5000 })).rejects.toThrow(/NOAUTH/);
    expect(calls()).toBe(1);
  });

  test("giving up is an error that names the last unknown state", async () => {
    const { b } = scripted([loading()]);
    await expect(b.waitReady({ intervalMs: 20, timeoutMs: 60 })).rejects.toThrow(/not ready before the deadline: .*LOADING/);
  });
});

// The two long-running daemons must really use it: started against a server that answers LOADING
// first, they wait and then start, instead of dying and leaving the restart to launchd.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

async function loadingServer(loadingReplies: number): Promise<{ port: number; close: () => void }> {
  let seen = 0;
  const server = net.createServer((sock) => {
    sock.on("data", (d) => {
      for (const _ of d.toString("latin1").matchAll(/^\*\d+\r\n/gm)) {
        seen++;
        sock.write(seen <= loadingReplies ? "-LOADING Valkey is loading the dataset in memory\r\n" : `$${LIBRARY_VERSION.length}\r\n${LIBRARY_VERSION}\r\n`);
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

for (const daemon of ["ingest.ts", "waker.ts"]) {
  test(`${daemon} waits for a loading server and then starts`, async () => {
    const srv = await loadingServer(2);
    const proc = spawn(process.execPath, ["run", "--silent", "--no-env-file", path.join(SRC, daemon)], {
      env: { PATH: process.env.PATH ?? "", MCTL_BRIDGE_VALKEY_URL: `redis://127.0.0.1:${srv.port}/0`, MCTL_BRIDGE_THREAD_ID: "t-1" },
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    try {
      const end = Date.now() + 15_000;
      while (Date.now() < end && !out.includes('"msg":"started"')) await new Promise((r) => setTimeout(r, 50));
      expect(out).toContain("waiting for valkey");
      expect(out).toContain("LOADING");
      expect(out).toContain('"msg":"started"');
      expect(proc.exitCode).toBeNull(); // still running: it did not die and wait for a supervisor
    } finally {
      proc.kill("SIGTERM");
      srv.close();
    }
  }, 30_000);
}

// `init` is what install.sh runs right after it restarts the server. valkey-cli PING exits 0 on a
// LOADING reply, so the shell cannot tell; the command itself has to wait. Against a real server
// behind a proxy that answers LOADING to the first commands, `init` must wait and then succeed.
import { afterAll, beforeAll } from "bun:test";
import { ValkeyServer, requiresValkey } from "./support.ts";

describe.skipIf(requiresValkey)("init against a server that is still loading", () => {
  let server: ValkeyServer;
  beforeAll(async () => {
    server = await ValkeyServer.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  test("init waits for LOADING to pass, then loads the library", async () => {
    let seen = 0;
    const proxy = net.createServer((sock) => {
      const up = net.connect(server.port, "127.0.0.1");
      up.on("data", (d) => sock.write(d));
      up.on("error", () => sock.destroy());
      sock.on("data", (d) => {
        seen++;
        if (seen <= 3) sock.write("-LOADING Valkey is loading the dataset in memory\r\n");
        else up.write(d);
      });
      sock.on("error", () => up.destroy());
      sock.on("close", () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as net.AddressInfo).port;
    try {
      const proc = spawn(process.execPath, ["run", "--silent", "--no-env-file", path.join(SRC, "cli.ts"), "init"], {
        env: { PATH: process.env.PATH ?? "", MCTL_BRIDGE_VALKEY_URL: `redis://127.0.0.1:${port}/0` },
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(null);
        }, 30_000);
        proc.on("close", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      expect(err).toContain("waiting for valkey");
      expect(code).toBe(0);
      expect(JSON.parse(out.trim().split("\n").at(-1)!)).toMatchObject({ ok: true });
    } finally {
      proxy.close();
    }
  }, 40_000);
});
