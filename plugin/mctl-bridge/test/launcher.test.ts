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
  // the pty host is not started in tests: record how it was asked to start
  stub(path.join(bin, "fakepython"), `[ "$3" = ping ] && exit 1\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${record}/screen"`);
  // claude: one argv per line is ambiguous for odd args, so write NUL-separated.
  stub(path.join(home, ".local", "bin", "claude"), `pwd -P > "${record}/cwd"\nprintf '%s\\0' "$@" > "${record}/argv"`);
  fs.writeFileSync(path.join(H, "plugin", "hooks", "state.py"), `import pathlib\npathlib.Path(${JSON.stringify(path.join(record, "hook"))}).write_text("ran")\n`);
  const env = { ...process.env, HOME: home, MCTL_BRIDGE_HOME: H, BUN: "/opt/my bun/bin/bun", MCTL_BRIDGE_TRUSTED_EXPERIMENT: "1", MCTL_BRIDGE_PYTHON: path.join(root, "bin", "fakepython"), PATH: `${bin}:${process.env.PATH}` };
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
    expect(srv.env.MCTL_BRIDGE_VALKEY_PASSWORD_FILE).toBe(path.join(d, "slot.pw"));
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
    expect(fs.existsSync(path.join(d, "log", "slot-s1.err"))).toBe(true);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("without the slot user, start refuses unless the trusted experiment is asked for", () => {
    const t = setup();
    stub(path.join(t.root, "bin", "id"), "exit 1");
    const env = { ...t.env, MCTL_BRIDGE_TRUSTED_EXPERIMENT: "0" };
    const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("host-boundary.sh");
    expect(fs.existsSync(path.join(t.H, "slots"))).toBe(false);
    expect(fs.existsSync(path.join(t.record, "screen"))).toBe(false);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("with the slot user, every file and the screen session host go through sudo -n -H -u and land in the slot home", () => {
    const t = setup();
    const homes = path.join(t.root, "homes");
    fs.mkdirSync(path.join(homes, "mctl-slot-s1"), { recursive: true });
    stub(path.join(t.root, "bin", "id"), "exit 0");
    // sudo stub: records who it was asked to become, then runs the command as ourselves
    stub(path.join(t.root, "bin", "sudo"), `printf '%s\\n' "$*" >> "${t.record}/sudo"\n[ "$1 $2 $3" = "-n -H -u" ] || exit 99\nshift 4\nexec "$@"`);
    const env = { ...t.env, MCTL_BRIDGE_TRUSTED_EXPERIMENT: "0", MCTL_BRIDGE_SLOT_HOME_ROOT: homes };
    const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const d = path.join(homes, "mctl-slot-s1", ".mctl-bridge");
    for (const f of ["mcp.json", "settings.json", "run.sh", "slot.pw"]) expect(fs.existsSync(path.join(d, f))).toBe(true);
    // password copied into the slot's home with mode 600; the operator copy is not what the MCP reads
    expect(fs.readFileSync(path.join(d, "slot.pw"), "utf8").trim()).toBe("deadbeefdeadbeef");
    expect((fs.statSync(path.join(d, "slot.pw")).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(path.join(d, "run.sh")).mode & 0o777).toString(8)).toBe("700");
    expect((fs.statSync(d).mode & 0o777).toString(8)).toBe("700");
    const mcp = JSON.parse(fs.readFileSync(path.join(d, "mcp.json"), "utf8"));
    expect(mcp.mcpServers["mctl-bridge"].env.MCTL_BRIDGE_VALKEY_PASSWORD_FILE).toBe(path.join(d, "slot.pw"));
    expect(fs.readFileSync(path.join(d, "run.sh"), "utf8")).toContain(`2>>'${d}'/log/slot-s1.err`);
    // the keychain password never goes on a command line (visible to every local user in ps)
    const runsh = fs.readFileSync(path.join(d, "run.sh"), "utf8");
    expect(runsh).not.toMatch(/security\s+(unlock|create)-keychain/); // would take the password from argv or /dev/tty
    expect(runsh).toMatch(/\|\s*security -i\b/);
    // nothing was written to the operator-side slots dir, and the screen was started via sudo as the slot user
    expect(fs.existsSync(path.join(t.H, "slots"))).toBe(false);
    const sudo = fs.readFileSync(path.join(t.record, "sudo"), "utf8");
    expect(sudo).toContain("-n -H -u mctl-slot-s1");
    expect(sudo).toMatch(/fakepython -I .*slot-pty\.py start /);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("the boundary probe refuses duplicate or single slots instead of passing with nothing to check", () => {
    const t = setup();
    stub(path.join(t.root, "bin", "sudo"), `echo called >> "${t.record}/sudo"; exit 0`);
    for (const args of [["s1"], ["s1", "s1"]]) {
      const r = spawnSync("zsh", [path.join(OPS, "host-boundary-probe.sh"), ...args], { env: t.env, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stdout).not.toContain("PASSED");
    }
    expect(fs.existsSync(path.join(t.record, "sudo"))).toBe(false); // nothing was run as a slot
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
