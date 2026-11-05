// install.sh restarts Valkey and then runs `init`. Both can fail, and by then the old ingest and
// waker are already booted out: a failed install must still bring every job back up and say so
// loudly, and a server that is only LOADING must never count as ready (valkey-cli exits 0 on it).
// The real script runs in a sandbox HOME with stubbed launchctl, valkey-cli, valkey-server and bun.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops", "install.sh");

function sandbox(opts: { valkey: "pong" | "loading"; initRc: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-install-"));
  const home = path.join(root, "home");
  const H = path.join(home, "mctl-bridge");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(H, "valkey", "bin"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const script = (file: string, body: string) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  script(path.join(H, "valkey", "bin", "valkey-server"), "exit 0");
  script(
    path.join(H, "valkey", "bin", "valkey-cli"),
    opts.valkey === "loading" ? 'echo "LOADING Valkey is loading the dataset in memory"; exit 0' : 'echo PONG',
  );
  script(path.join(bin, "bun"), `case "$*" in *" init"*) exit ${opts.initRc};; esac; exit 0`);
  script(path.join(bin, "launchctl"), `echo "$*" >> "${root}/launchctl.log"; [ "$1" = print ] && exit 1; exit 0`);
  const r = spawnSync("zsh", [INSTALL, "t-thread"], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      MCTL_BRIDGE_HOME: H,
      BUN: path.join(bin, "bun"),
      MCTL_BRIDGE_READY_TRIES: "2",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const log = fs.existsSync(path.join(root, "launchctl.log")) ? fs.readFileSync(path.join(root, "launchctl.log"), "utf8") : "";
  fs.rmSync(root, { recursive: true, force: true });
  return { code: r.status, err: r.stderr, out: r.stdout, log };
}

const started = (log: string, job: string) => new RegExp(`kickstart gui/\\d+/com\\.mctl\\.bridge-${job}\\b`).test(log);

describe("install.sh", () => {
  test("a healthy install exits 0 and starts every job", () => {
    const r = sandbox({ valkey: "pong", initRc: 0 });
    expect(r.err).not.toContain("INSTALL FAILED");
    expect(r.code).toBe(0);
    for (const j of ["valkey", "ingest", "waker"]) expect(started(r.log, j)).toBe(true);
    expect(r.out).toContain("installed:");
  });

  test("a server that only answers LOADING is not ready: loud failure, jobs still started", () => {
    const r = sandbox({ valkey: "loading", initRc: 0 });
    expect(r.code).toBe(1);
    expect(r.err).toContain("INSTALL FAILED: valkey did not become ready");
    expect(r.out).not.toContain("installed:");
    for (const j of ["ingest", "waker"]) expect(started(r.log, j)).toBe(true);
  });

  test("a failed init is loud and still brings ingest and waker back", () => {
    const r = sandbox({ valkey: "pong", initRc: 1 });
    expect(r.code).toBe(1);
    expect(r.err).toContain("INSTALL FAILED: mctl-bridge init failed");
    for (const j of ["ingest", "waker"]) expect(started(r.log, j)).toBe(true);
  });
});
