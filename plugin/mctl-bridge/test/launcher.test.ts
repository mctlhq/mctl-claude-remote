// The launcher scripts interpolate paths into generated JSON and zsh. Paths are data:
// a directory with a space, quote, dollar sign and double quote must come out as valid
// JSON, valid zsh, and an exact directory and argv for claude.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops");
const have = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const usable = have("zsh") && fs.existsSync("/usr/bin/python3");

// Characters that break naive interpolation: space, ', $, ", \, `, and a $( ) marker.
const NASTY = `we ird'q $HOME "dq" back\\slash \`bt\` $(touch MARKER)`;

function stub(file: string, body: string) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-")));
  const home = path.join(root, `home ${NASTY}`);
  const H = path.join(root, `bridge ${NASTY}`);
  const repo = path.join(root, `repo ${NASTY}`);
  const bin = path.join(root, "bin");
  const record = path.join(root, "record");
  for (const d of [home, repo, bin, record, path.join(home, ".local", "bin"), path.join(H, "valkey", "bin"), path.join(H, "etc"), path.join(H, "plugin", "hooks")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(H, "etc", "admin.pw"), "adminpw");
  stub(path.join(H, "valkey", "bin", "valkey-cli"), "exit 0");
  stub(path.join(bin, "openssl"), "echo deadbeefdeadbeef");
  stub(path.join(bin, "screen"), `[ "$1" = -ls ] && exit 0\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${record}/screen"`);
  // claude: one argv per line is ambiguous for odd args, so write NUL-separated.
  stub(path.join(home, ".local", "bin", "claude"), `pwd -P > "${record}/cwd"\nprintf '%s\\0' "$@" > "${record}/argv"`);
  fs.writeFileSync(path.join(H, "plugin", "hooks", "state.py"), `import pathlib\npathlib.Path(${JSON.stringify(path.join(record, "hook"))}).write_text("ran")\n`);
  const env = { ...process.env, HOME: home, MCTL_BRIDGE_HOME: H, BUN: "/opt/my bun/bin/bun", PATH: `${bin}:${process.env.PATH}` };
  return { root, home, H, repo, record, env };
}

describe.skipIf(!usable)("launcher scripts", () => {
  test("slot.sh start writes valid JSON and zsh for a hostile path, and run.sh execs claude exactly", () => {
    const t = setup();
    const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env: t.env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const d = path.join(t.H, "slots", "s1");

    const mcp = JSON.parse(fs.readFileSync(path.join(d, "mcp.json"), "utf8"));
    const srv = mcp.mcpServers["mctl-bridge"];
    expect(srv.command).toBe("/opt/my bun/bin/bun");
    expect(srv.args).toEqual(["run", "--silent", "--no-env-file", `--config=${t.H}/plugin/bunfig.toml`, `${t.H}/plugin/src/channel.ts`]);
    expect(srv.env.MCTL_BRIDGE_VALKEY_PASSWORD_FILE).toBe(path.join(t.H, "etc", "slot-s1.pw"));
    expect(srv.env.MCTL_BRIDGE_VALKEY_URL).toBe("redis://bridge_slot_s1@127.0.0.1:6390/0");

    // the hook command is run by a shell: it must run state.py from the odd path
    const settings = JSON.parse(fs.readFileSync(path.join(d, "settings.json"), "utf8"));
    const hook = settings.hooks.Stop[0].hooks[0].command as string;
    expect(spawnSync("sh", ["-c", hook], { cwd: t.root }).status).toBe(0);
    expect(fs.readFileSync(path.join(t.record, "hook"), "utf8")).toBe("ran");

    expect(spawnSync("zsh", ["-n", path.join(d, "run.sh")]).status).toBe(0);
    const run = spawnSync(path.join(d, "run.sh"), [], { env: t.env, cwd: t.root, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(fs.readFileSync(path.join(t.record, "cwd"), "utf8").trim()).toBe(t.repo);
    expect(fs.readFileSync(path.join(t.record, "argv"), "utf8").split("\0").slice(0, -1)).toEqual([
      "--model", "haiku",
      "--mcp-config", path.join(d, "mcp.json"),
      "--strict-mcp-config",
      "--settings", path.join(d, "settings.json"),
      "--dangerously-load-development-channels", "server:mctl-bridge",
      "--allowedTools", "mcp__mctl-bridge__ack_task,mcp__mctl-bridge__ack_reply,mcp__mctl-bridge__ask_orchestrator,mcp__mctl-bridge__report_result,mcp__mctl-bridge__bridge_status",
      "--permission-mode", "default",
    ]);
    // no $(...) in any path was executed
    expect(fs.existsSync(path.join(t.root, "MARKER"))).toBe(false);
    expect(fs.existsSync(path.join(t.repo, "MARKER"))).toBe(false);
    expect(fs.existsSync(path.join(t.H, "log", "slot-s1.err"))).toBe(true);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("ops/mctl-bridge passes its arguments and a hostile home path through unchanged", () => {
    const t = setup();
    const bun = path.join(t.root, "bin", "fakebun");
    stub(bun, `printf '%s\\0' "$MCTL_BRIDGE_VALKEY_PASSWORD_FILE" "$@" > "${t.record}/cli"`);
    const args = ["reply", "q-1", "--text", `it's "x" $(touch MARKER) \`y\` \\z`, "--", "--dash"];
    const r = spawnSync("zsh", [path.join(OPS, "mctl-bridge"), ...args], { env: { ...t.env, BUN: bun }, cwd: t.root });
    expect(r.status).toBe(0);
    const got = fs.readFileSync(path.join(t.record, "cli"), "utf8").split("\0").slice(0, -1);
    expect(got[0]).toBe(path.join(t.H, "etc", "orch.pw"));
    expect(got.slice(1, 6)).toEqual(["run", "--silent", "--no-env-file", `--config=${t.H}/plugin/bunfig.toml`, `${t.H}/plugin/src/cli.ts`]);
    expect(got.slice(6)).toEqual(args);
    expect(fs.existsSync(path.join(t.root, "MARKER"))).toBe(false);
    fs.rmSync(t.root, { recursive: true, force: true });
  });
});
