import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { HEALTH_KEY, HEALTH_STALE_MS, readHealth, writeHealth } from "../src/health.ts";
import { Waker } from "../src/waker.ts";
import { FakeApp } from "./fakeapp.ts";
import { ValkeyServer, requiresValkey } from "./support.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

describe.skipIf(requiresValkey)("orchestrator reachability", () => {
  let server: ValkeyServer;
  let app: FakeApp;
  beforeEach(async () => {
    server = await ValkeyServer.start();
    app = new FakeApp().start();
  });
  afterEach(async () => {
    app.stop();
    await server.stop();
  });

  async function setup() {
    const b = await server.bridge();
    const w = new Waker(b, {
      threadId: app.threadId, socketPath: app.path, quietMs: 0, perHour: 10,
      perQuestion: 2, turnTimeoutMs: 3000, rpcTimeoutMs: 1000, pollMs: 20, staleMs: 30_000,
    });
    return { b, w };
  }

  test("archived thread is visible in errors without any question or wake; recovery clears it", async () => {
    const { b, w } = await setup();
    app.archived = true;
    expect(await w.checkHealth()).toBeNull();
    expect((await run(["errors"], b)).out).toMatchObject({
      ok: true, healthy: false, unknown: [], wakes: [], late: {},
      orchestrator: { status: "unavailable", reason: "thread_unreadable", thread_id: app.threadId, detail: expect.stringContaining("archived") },
    });
    expect(app.starts).toHaveLength(0);
    app.archived = false;
    expect(await w.checkHealth()).toBe("idle");
    expect((await run(["errors"], b)).out).toMatchObject({ healthy: true, orchestrator: { status: "healthy", thread_status: "idle" } });
    expect(app.starts).toHaveLength(0);
  });

  test("active is reachable, missing or unrecognized status is not", async () => {
    const { b, w } = await setup();
    app.restingStatus = "active";
    expect(await w.checkHealth()).toBe("active");
    expect((await readHealth(b.exec)).status).toBe("healthy");
    app.brokenStatus = true;
    expect(await w.checkHealth()).toBeNull();
    expect((await readHealth(b.exec)).status).toBe("unavailable");
    app.brokenStatus = false;
    app.restingStatus = "new-status";
    expect(await w.checkHealth()).toBeNull();
  });

  test("no heartbeat, stale heartbeat, corrupt data and future time never report healthy", async () => {
    const { b, w } = await setup();
    expect((await run(["errors"], b)).out).toMatchObject({ healthy: false, orchestrator: { status: "unknown", reason: "not_observed" } });
    await w.checkHealth();
    const h = await readHealth(b.exec);
    expect(await readHealth(b.exec, h.checked_ms! + HEALTH_STALE_MS + 1)).toMatchObject({ status: "unknown", reason: "stale_observation" });
    expect(await readHealth(b.exec, h.checked_ms! - 1)).toMatchObject({ status: "unknown" });
    for (const raw of ["not json", "null", "{}", '{"status":"healthy"}']) {
      await b.exec.execute(["SET", HEALTH_KEY, raw]);
      expect(await readHealth(b.exec)).toMatchObject({ status: "unknown", reason: "invalid_observation" });
    }
  });

  test("socket failure replaces a previous healthy observation", async () => {
    const { b, w } = await setup();
    await writeHealth(b.exec, { status: "healthy", reason: "reachable", thread_id: app.threadId, checked_ms: Date.now() });
    app.stop();
    expect(await w.checkHealth()).toBeNull();
    expect((await run(["errors"], b)).out).toMatchObject({ healthy: false, orchestrator: { status: "unavailable" } });
  });

  test("the daemon probes an archived thread even with no messages", async () => {
    const { b } = await setup();
    app.archived = true;
    const child = spawn(process.execPath, ["run", fileURLToPath(new URL("../src/waker.ts", import.meta.url))], {
      env: { ...process.env, MCTL_BRIDGE_VALKEY_URL: server.url, MCTL_BRIDGE_VALKEY_PASSWORD_FILE: "",
        MCTL_BRIDGE_THREAD_ID: app.threadId, MCTL_BRIDGE_CODEX_SOCKET: app.path, MCTL_BRIDGE_RECONCILE_SLOTS: "" },
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const deadline = Date.now() + 3000;
      while ((await readHealth(b.exec)).status === "unknown" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await readHealth(b.exec)).toMatchObject({ status: "unavailable", detail: expect.stringContaining("archived") });
      expect(app.starts).toHaveLength(0);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });
});
