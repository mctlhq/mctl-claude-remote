// ops/codex-remote-guard.sh restarts an unmanaged Codex app-server so the ChatGPT app can
// reach it, but never while a wake is in flight and never on an unknown state.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops", "codex-remote-guard.sh");
const usable = spawnSync("sh", ["-c", "command -v awk tail"]).status === 0;

const MANAGED = "22468 /x/bin/codex app-server --remote-control --listen unix:// --managed-daemon";
const UNMANAGED = "686 codex -c features.code_mode_host=true app-server --listen unix://";
const PROXY = "690 codex app-server proxy --listen unix://";
const w = (msg: string) => JSON.stringify({ t: "2026-11-04T21:47:54.158Z", src: "mctl-bridge-waker", msg });

function run(opts: { ps: string[]; log?: string[] | null; killFails?: boolean }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")));
  const rec = path.join(root, "rec");
  fs.writeFileSync(path.join(root, "ps"), `#!/bin/sh\necho "$*" > "${root}/psargs"\ncat <<'EOF2'\n${opts.ps.join("\n")}\nEOF2\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "kill"), `#!/bin/sh\necho "kill $*" >> "${rec}"\n${opts.killFails ? "exit 1" : "exit 0"}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "codex"), `#!/bin/sh\necho "codex $*" >> "${rec}"\n`, { mode: 0o755 });
  const log = path.join(root, "waker.log");
  if (opts.log !== null) fs.writeFileSync(log, (opts.log ?? []).join("\n") + "\n");
  const r = spawnSync("sh", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, MCTL_GUARD_PS: path.join(root, "ps"), MCTL_GUARD_KILL: path.join(root, "kill"), MCTL_GUARD_CODEX: path.join(root, "codex"), MCTL_GUARD_WAKER_LOG: log, MCTL_GUARD_SLEEP: "0" },
  });
  const calls = fs.existsSync(rec) ? fs.readFileSync(rec, "utf8").trim().split("\n") : [];
  const psArgs = fs.readFileSync(path.join(root, "psargs"), "utf8");
  fs.rmSync(root, { recursive: true, force: true });
  return { status: r.status, out: r.stdout, calls, psArgs };
}

describe.skipIf(!usable)("codex-remote-guard", () => {
  test("managed server with --remote-control is left alone", () => {
    const r = run({ ps: [MANAGED, PROXY], log: [w("started")] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("an unmanaged server on an idle waker is stopped and the managed daemon is started", () => {
    const r = run({ ps: [UNMANAGED, PROXY], log: [w("started"), w("wake intent"), w("wake started"), w("wake completed")] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["kill 686", "codex remote-control start"]);
  });

  test("a wake in flight blocks the restart", () => {
    for (const open of [[w("wake intent")], [w("wake intent"), w("wake started")]]) {
      const r = run({ ps: [UNMANAGED], log: [w("started"), ...open] });
      expect(r.status).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.out).toContain("wake is in flight");
    }
  });

  test("a failed or lost wake counts as finished", () => {
    for (const end of ["wake failed", "wake no longer ours"]) {
      const r = run({ ps: [UNMANAGED], log: [w("started"), w("wake intent"), w("wake started"), w(end)] });
      expect(r.calls).toEqual(["kill 686", "codex remote-control start"]);
    }
  });

  test("a waker restart orphans an open wake: it no longer blocks", () => {
    const r = run({ ps: [UNMANAGED], log: [w("wake intent"), w("wake started"), w("started")] });
    expect(r.calls).toEqual(["kill 686", "codex remote-control start"]);
  });

  test("an unreadable waker log is unknown, not idle: nothing is restarted", () => {
    const r = run({ ps: [UNMANAGED], log: null });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("unreadable");
  });

  test("a wake stays open when the waker then logs thousands of other lines", () => {
    const noise = Array.from({ length: 3000 }, () => w("sweep"));
    const r = run({ ps: [UNMANAGED], log: [w("started"), w("wake intent"), w("wake started"), ...noise] });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("wake is in flight");
  });

  test("a long command line is read whole: ps is asked for no truncation", () => {
    const r = run({ ps: [MANAGED], log: [w("started")] });
    expect(r.psArgs).toMatch(/^-\w*ww\b/);
  });

  test("a proxy alone is a client, not a server: nothing happens", () => {
    const r = run({ ps: [PROXY], log: [w("started")] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  test("a server that cannot be stopped fails the run and starts nothing", () => {
    const r = run({ ps: [UNMANAGED], log: [w("started")], killFails: true });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(["kill 686"]);
  });

  test("both an unmanaged and a managed server: only the unmanaged one is stopped", () => {
    const r = run({ ps: [UNMANAGED, MANAGED], log: [w("started")] });
    expect(r.calls).toEqual(["kill 686", "codex remote-control start"]);
  });
});
