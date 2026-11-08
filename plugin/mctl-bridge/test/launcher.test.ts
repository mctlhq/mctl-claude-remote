// The launcher scripts interpolate paths into generated JSON and zsh. Paths are data:
// a directory with a space, quote, dollar sign and double quote must come out as valid
// JSON, valid zsh, and an exact directory and argv for claude.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUCTIONS } from "../src/channel.ts";

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
    // the default model is Sonnet, and the start line says which model the slot got
    expect(r.stdout).toContain(" on model sonnet ");
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

    // permission rules: local work allowed, remote writes and credentials denied, no overlap
    const { allow, deny } = settings.permissions as { allow: string[]; deny: string[] };
    for (const r of ["Bash(git fetch origin:*)", "Bash(git checkout:*)", "Bash(git commit:*)", "Bash(python3 -m unittest:*)"]) expect(allow).toContain(r);
    for (const r of ["Bash(git push:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(sudo:*)", "Bash(git remote:*)", "Bash(git config:*)"]) expect(deny).toContain(r);
    expect(allow.filter((r) => deny.includes(r))).toEqual([]);
    // a Read deny does not bind a Bash subprocess, so no general Bash reader may be pre-allowed
    for (const reader of ["cat", "grep", "rg", "sed", "jq", "diff", "cmp", "less", "more", "awk", "sort", "uniq"])
      expect(allow.some((a) => a.startsWith(`Bash(${reader}`))).toBe(false);
    // the bridge suite runs from the repository root under the bun test rule; never a general
    // bun --cwd rule, a cd, or a python that reads its program from stdin
    expect(allow).toContain("Bash(bun test:*)");
    expect(allow.some((a) => a.startsWith("Bash(bun --cwd"))).toBe(false);
    expect(allow.some((a) => a.startsWith("Bash(cd") || a.startsWith("Bash(python3 -:") || a.startsWith("Bash(python3:"))).toBe(false);
    // pipe filters are allowed so a compound command does not prompt on its last stage
    for (const f of ["head", "tail", "wc", "cut"]) expect(allow).toContain(`Bash(${f}:*)`);
    // ...and every credential path is denied by command text, since a filter can read a file
    for (const frag of [".ssh", ".config/gh", ".aws", ".git-credentials", ".pw", "keychain"]) expect(deny).toContain(`Bash(*${frag}*)`);
    for (const r of ["Bash(rm -fr:*)", "Bash(rm -r -f:*)"]) expect(deny).toContain(r);
    // an allow rule must never cover a denied command family by prefix
    for (const a of allow) for (const bad of ["git push", "gh ", "curl", "wget", "ssh", "sudo", "security"]) expect(a.startsWith(`Bash(${bad}`)).toBe(false);
    // build, typecheck and Go tests run without a prompt (operator decision 2026-11-07)
    for (const r of ["Bash(go build:*)", "Bash(go test:*)", "Bash(go vet:*)", "Bash(bun run typecheck)", "Bash(bun run --cwd plugin/mctl-bridge typecheck)", "Bash(git rebase origin/main)", "Bash(git rebase --continue)"]) expect(allow).toContain(r);
    // ...but nothing that runs a program of the command line's choosing: no general bun run, go run,
    // go generate, go mod or go get, and no rebase form that would take --exec
    for (const bad of ["Bash(bun run:", "Bash(go run", "Bash(go generate", "Bash(go mod", "Bash(go get", "Bash(go install", "Bash(git rebase:", "Bash(git merge", "Bash(gofmt -w", "Bash(gofmt:"]) expect(allow.some((a) => a.startsWith(bad))).toBe(false);
    for (const r of ["Bash(go *-exec*)", "Bash(go *-toolexec*)", "Bash(go *-vettool*)"]) expect(deny).toContain(r);
    // a rebase that stops on a conflict must not open an editor in a terminal nobody sees
    expect(settings.env).toEqual({ GIT_EDITOR: "true" });

    expect(spawnSync("zsh", ["-n", path.join(d, "run.sh")]).status).toBe(0);
    const run = spawnSync(path.join(d, "run.sh"), [], { env: t.env, cwd: t.root, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(fs.readFileSync(path.join(t.record, "cwd"), "utf8").trim()).toBe(t.repo);
    expect(fs.readFileSync(path.join(t.record, "argv"), "utf8").split("\0").slice(0, -1)).toEqual([
      "--remote-control", "mctl-slot-S1",
      "--model", "sonnet",
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

  const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const BASE_ARGV = (d: string) => [
    "--remote-control", "mctl-slot-S1",
    "--model", "sonnet",
    "--mcp-config", path.join(d, "mcp.json"),
    "--strict-mcp-config",
    "--settings", path.join(d, "settings.json"),
    "--dangerously-load-development-channels", "server:mctl-bridge",
    "--allowedTools", "mcp__mctl-bridge__ack_task,mcp__mctl-bridge__ack_reply,mcp__mctl-bridge__ask_orchestrator,mcp__mctl-bridge__report_result,mcp__mctl-bridge__bridge_status",
    "--permission-mode", "default",
  ];
  const argvOf = (t: ReturnType<typeof setup>) => {
    const d = path.join(t.H, "slots", "s1");
    expect(spawnSync(path.join(d, "run.sh"), [], { env: t.env, cwd: t.root, encoding: "utf8" }).status).toBe(0);
    return fs.readFileSync(path.join(t.record, "argv"), "utf8").split("\0").slice(0, -1);
  };

  test("start without --resume leaves run.sh exactly as before (no --resume anywhere)", () => {
    const t = setup();
    expect(spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env: t.env, encoding: "utf8" }).status).toBe(0);
    expect(fs.readFileSync(path.join(t.H, "slots", "s1", "run.sh"), "utf8")).not.toContain("--resume");
    expect(argvOf(t)).toEqual(BASE_ARGV(path.join(t.H, "slots", "s1")));
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("start --resume <id> adds --resume <id> after --model and keeps every other argument", () => {
    const t = setup();
    const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo, "--resume", SID], { env: t.env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const d = path.join(t.H, "slots", "s1");
    expect(spawnSync("zsh", ["-n", path.join(d, "run.sh")]).status).toBe(0);
    // the id is zsh-quoted in the generated script like every other value
    expect(fs.readFileSync(path.join(d, "run.sh"), "utf8")).toContain(`--model 'sonnet' --resume '${SID}' --mcp-config`);
    const base = BASE_ARGV(d);
    expect(argvOf(t)).toEqual([...base.slice(0, 4), "--resume", SID, ...base.slice(4)]);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("start --resume refuses an id that is not a UUID: nothing is written and nothing is executed", () => {
    const bad = [
      "", "abc", "$(touch MARKER)", `${SID}; touch MARKER`, `${SID}'$(touch MARKER)`, "`touch MARKER`",
      `${SID} --dangerously-skip-permissions`, `${SID}\n`, "../../etc/passwd", SID.slice(1), `${SID}0`,
    ];
    for (const id of bad) {
      const t = setup();
      const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo, "--resume", id], { env: t.env, cwd: t.root, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("bad session id");
      expect(fs.existsSync(path.join(t.H, "slots"))).toBe(false); // refused before any file was generated
      expect(fs.existsSync(path.join(t.record, "screen"))).toBe(false);
      for (const dir of [t.root, t.repo, t.H, process.cwd()]) expect(fs.existsSync(path.join(dir, "MARKER"))).toBe(false);
      fs.rmSync(t.root, { recursive: true, force: true });
    }
    // a stray extra argument, or --resume without an id, is a usage error as well, not a fresh session
    const t = setup();
    for (const extra of [["--bogus", SID], ["--resume"], ["--resume", SID, "extra"], ["", "--resume", SID], [""], ["--resume", ""]]) {
      const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo, ...extra], { env: t.env, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(fs.existsSync(path.join(t.H, "slots"))).toBe(false);
    }
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("run.sh points the hook and the adapter at the slot's own state dir, the one session-id reads", () => {
    const t = setup();
    expect(spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env: t.env, encoding: "utf8" }).status).toBe(0);
    const d = path.join(t.H, "slots", "s1");
    stub(path.join(t.home, ".local", "bin", "claude"), `printf '%s' "$MCTL_BRIDGE_STATE_DIR" > "${t.record}/statedir"`);
    expect(spawnSync(path.join(d, "run.sh"), [], { env: t.env, cwd: t.root }).status).toBe(0);
    expect(fs.readFileSync(path.join(t.record, "statedir"), "utf8")).toBe(path.join(d, "state"));
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("run.sh puts bun and the Valkey binaries on PATH, after the existing entries", () => {
    const t = setup();
    expect(spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env: t.env, encoding: "utf8" }).status).toBe(0);
    const d = path.join(t.H, "slots", "s1");
    stub(path.join(t.home, ".local", "bin", "claude"), `printf '%s' "$PATH" > "${t.record}/path"`);
    expect(spawnSync(path.join(d, "run.sh"), [], { env: t.env, cwd: t.root }).status).toBe(0);
    expect(fs.readFileSync(path.join(t.record, "path"), "utf8")).toBe(
      `${t.home}/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/my bun/bin:${t.H}/valkey/bin`,
    );
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("session-id prints the running slot's newest recorded id on one line, and fails when it cannot", () => {
    const t = setup();
    const alive = path.join(t.root, "bin", "alivepython");
    stub(alive, `exit 0`);
    const dead = t.env;
    const live = { ...t.env, MCTL_BRIDGE_PYTHON: alive };
    const d = path.join(t.H, "slots", "s1");
    const run = (env: NodeJS.ProcessEnv) => spawnSync("zsh", [path.join(OPS, "slot.sh"), "session-id", "s1"], { env, encoding: "utf8" });
    const put = (name: string, rec: object) => {
      fs.mkdirSync(path.join(d, "state"), { recursive: true });
      fs.writeFileSync(path.join(d, "state", name), JSON.stringify(rec));
    };

    // no state file at all
    let r = run(live);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no readable session id");

    // unreadable, non-UUID and missing-field records are errors, never an empty line
    put("1.json", { session_id: "$(touch MARKER)", t: 5 });
    put("2.json", { state: "idle", t: 6 });
    fs.writeFileSync(path.join(d, "state", "3.json"), "{not json");
    r = run(live);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");

    // an older pid file and a newer one: the newest wins
    put("10.json", { session_id: "11111111-2222-3333-4444-555555555555", t: 100 });
    put("11.json", { session_id: SID, t: 200 });
    r = run(live);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${SID}\n`);

    // a slot that is not running has no current session, whatever stale files remain
    r = run(dead);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not running");
    expect(fs.existsSync(path.join(t.root, "MARKER"))).toBe(false);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("Remote Control is on by default, named per slot, and can be turned off", () => {
    const on = setup();
    expect(spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "ab-2", on.repo], { env: on.env, encoding: "utf8" }).status).toBe(0);
    const runOn = fs.readFileSync(path.join(on.H, "slots", "ab-2", "run.sh"), "utf8");
    expect(runOn).toContain("--remote-control 'mctl-slot-AB-2' --model");
    fs.rmSync(on.root, { recursive: true, force: true });

    const off = setup();
    const r = spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "ab-2", off.repo], { env: { ...off.env, MCTL_BRIDGE_REMOTE_CONTROL: "0" }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(off.H, "slots", "ab-2", "run.sh"), "utf8")).not.toContain("--remote-control");
    fs.rmSync(off.root, { recursive: true, force: true });
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

  test("kill is allowed only behind the slot user boundary, never in the trusted experiment", () => {
    const allowOf = (file: string): string[] => JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow;
    const t = setup();
    expect(spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env: t.env, encoding: "utf8" }).status).toBe(0);
    const trusted = allowOf(path.join(t.H, "slots", "s1", "settings.json"));
    expect(trusted).toContain("Bash(ps -o pid,ppid,stat,lstart,command -p:*)");
    expect(trusted).not.toContain("Bash(kill:*)");
    const homes = path.join(t.root, "homes");
    fs.mkdirSync(path.join(homes, "mctl-slot-s2"), { recursive: true });
    stub(path.join(t.root, "bin", "id"), "exit 0");
    stub(path.join(t.root, "bin", "sudo"), `[ "$1 $2 $3" = "-n -H -u" ] || exit 99\nshift 4\nexec "$@"`);
    const env = { ...t.env, MCTL_BRIDGE_TRUSTED_EXPERIMENT: "0", MCTL_BRIDGE_SLOT_HOME_ROOT: homes };
    expect(spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s2", t.repo], { env, encoding: "utf8" }).status).toBe(0);
    const bounded = allowOf(path.join(homes, "mctl-slot-s2", ".mctl-bridge", "settings.json"));
    expect(bounded).toContain("Bash(kill:*)");
    expect(bounded.filter((r) => r !== "Bash(kill:*)")).toEqual(trusted);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test("start installs packages from each committed lockfile, frozen and without scripts, and a failure does not stop it", () => {
    const t = setup();
    for (const d of ["plugin/a", "node_modules/dep", "deep/x/y/z"]) fs.mkdirSync(path.join(t.repo, d), { recursive: true });
    for (const f of ["plugin/a/bun.lock", "node_modules/dep/bun.lock", "deep/x/y/z/bun.lock"]) fs.writeFileSync(path.join(t.repo, f), "{}");
    const calls = path.join(t.record, "bun");
    const bun = path.join(t.root, "bin", "fakebun");
    stub(bun, `printf '%s|%s\\n' "$(pwd -P)" "$*" >> ${JSON.stringify(calls)}\n[ -e ${JSON.stringify(path.join(t.root, "fail"))} ] && { echo "lockfile had changes"; exit 1; }\nexit 0`);
    const run = (extra: Record<string, string> = {}) =>
      spawnSync("zsh", [path.join(OPS, "slot.sh"), "start", "s1", t.repo], { env: { ...t.env, BUN: bun, ...extra }, encoding: "utf8" });
    let r = run();
    expect(r.status).toBe(0);
    // only the lockfile within three levels, not the one inside node_modules nor the one four deep
    expect(fs.readFileSync(calls, "utf8")).toBe(`${path.join(t.repo, "plugin/a")}|install --frozen-lockfile --ignore-scripts\n`);
    expect(r.stdout).toContain("deps: installed in");
    fs.rmSync(calls);
    fs.writeFileSync(path.join(t.root, "fail"), "");
    r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("deps: bun install failed in");
    expect(r.stderr).toContain("lockfile had changes");
    expect(fs.existsSync(path.join(t.H, "slots", "s1", "run.sh"))).toBe(true);
    fs.rmSync(calls);
    r = run({ MCTL_BRIDGE_SLOT_DEPS: "0" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(calls)).toBe(false);
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

  test.skipIf(!usable || process.getuid?.() === 0)("the probe really tries the operator secrets, a foreign pid and the Codex socket, and goes red when one is open", () => {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/pr-"));
    const op = path.join(root, "op");
    const secret = path.join(op, ".codex", "auth.json");
    fs.mkdirSync(path.join(op, ".codex", "app-server-control"), { recursive: true });
    fs.writeFileSync(secret, "x", { mode: 0o000 });
    fs.chmodSync(path.join(op, ".codex", "app-server-control"), 0o000);
    const run = () => spawnSync("/usr/bin/python3", ["-I", path.join(OPS, "host-boundary-probe.py"), path.join(root, "H"), op, "x", "y", "pid=1"], { encoding: "utf8" }).stdout;
    try {
      const closed = run();
      expect(closed).toContain("PASS read operator secret .codex/auth.json: DENIED");
      expect(closed).toContain("FAIL read operator secret .codex/config.toml: ABSENT"); // unobservable is a failure, never a skip
      expect(closed).toContain("PASS signal foreign pid 1: DENIED");
      expect(closed).toContain("PASS connect Codex control socket (default path): DENIED");
      fs.chmodSync(secret, 0o644);
      expect(run()).toContain("FAIL read operator secret .codex/auth.json: ALLOWED");
    } finally {
      fs.chmodSync(path.join(op, ".codex", "app-server-control"), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the probe launcher hands every slot run a foreign pid to try to signal", () => {
    const t = setup();
    stub(path.join(t.root, "bin", "sudo"), `printf '%s\\n' "$*" >> "${t.record}/sudo"; exit 0`); // printf: dash's echo would expand the backslashes in the hostile paths
    const r = spawnSync("zsh", [path.join(OPS, "host-boundary-probe.sh"), "s1", "s2"], { env: t.env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const calls = fs.readFileSync(path.join(t.record, "sudo"), "utf8").trim().split("\n");
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/ pid=\d+ pid=1$/);
    fs.rmSync(t.root, { recursive: true, force: true });
  });

  test.skipIf(!usable)("the probe refuses a malformed pid argument instead of silently dropping it", () => {
    const r = spawnSync("/usr/bin/python3", ["-I", path.join(OPS, "host-boundary-probe.py"), "/nonexistent", "/nonexistent", "x", "y", "pid=abc"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bad argument");
    expect(r.stdout).not.toContain("PASS");
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

  test("channel instructions tell slots to stay at the repo root and use the Read tools", () => {
    expect(INSTRUCTIONS).toContain("Work from the repository root and never cd");
    expect(INSTRUCTIONS).toContain("Read, Grep and Glob tools, not cat, grep or sed in Bash");
    expect(INSTRUCTIONS).toContain("Edit files with the built-in Edit or Write tools, never with a script run through python3, sed -i,");
    expect(INSTRUCTIONS).toContain("Run syntax checks (sh -n, bash -n) as separate short commands.");
    expect(INSTRUCTIONS).toContain("bun test --cwd plugin/mctl-bridge and");
    expect(INSTRUCTIONS).toContain("python3 -m unittest discover -s plugin/mctl-bridge/test -p 'test_*.py'.");
    expect(INSTRUCTIONS).toContain("For a temporary mutation check: commit first, edit with the Edit tool, run the test, undo with");
    expect(INSTRUCTIONS).toContain("git restore <file>, and confirm with git status or git diff.");
    expect(INSTRUCTIONS).toContain("Never copy backups to a temp dir");
  });

  // 2026-11-07: of 115 approved slot prompts, at least 41 used a shell variable, 32 used git -C
  // and 14 began with export PATH: commands the allow rules could never match.
  test("channel instructions forbid the command shapes the allow rules cannot match", () => {
    expect(INSTRUCTIONS).toContain("never start one with export, a VAR=value assignment or a");
    expect(INSTRUCTIONS).toContain("PATH already holds bun and valkey-server.");
    expect(INSTRUCTIONS).toContain("never git -C <dir> and never an absolute path into another");
    expect(INSTRUCTIONS).toContain("call report_result with failed and say so");
    expect(INSTRUCTIONS).toContain("ends with the trailer Agent: claude. Never add Co-Authored-By");
    expect(INSTRUCTIONS).toContain("never with pkill -f");
    // every command rule 14 promises runs without a prompt is matched by slot.sh's allow list
    const sh = fs.readFileSync(path.join(import.meta.dir, "..", "ops", "slot.sh"), "utf8");
    const allowLine = sh.match(/^\s*allow='(.*)'$/m);
    expect(allowLine).not.toBeNull();
    const allowed = [...allowLine![1]!.matchAll(/"Bash\(([^"]*)\)"/g)].map((m) => m[1]!);
    const matches = (cmd: string): boolean => allowed.some((r) => (r.endsWith(":*") ? cmd.startsWith(r.slice(0, -2)) : cmd === r));
    const promised = ["go build ./...", "go test ./...", "go vet ./...", "bun run --cwd plugin/mctl-bridge typecheck", "git fetch origin", "git rebase origin/main", "git add", "git rebase --continue"];
    for (const cmd of promised) {
      expect(INSTRUCTIONS).toContain(cmd);
      expect([cmd, matches(cmd)]).toEqual([cmd, true]);
    }
    expect(INSTRUCTIONS).toContain("Never git merge: mctl-publish refuses merge commits.");
    expect(matches("git merge origin/main")).toBe(false);
    // rule 10: one command per call; a status suffix such as ; echo exit=$? holds a variable and prompts
    expect(INSTRUCTIONS).toContain("Run one");
    expect(INSTRUCTIONS).toContain("no ; echo exit=$? and no && or ; chains");
    // rule 15: ps by PID and date run in both modes; kill is added only behind the user boundary
    expect(INSTRUCTIONS).toContain("ps -o pid,ppid,stat,lstart,command -p <pid>");
    expect(matches("ps -o pid,ppid,stat,lstart,command -p 10436")).toBe(true);
    expect(matches("ps aux")).toBe(false);
    expect(matches("date -u")).toBe(true);
    expect(matches("kill 10436")).toBe(false);
    const denyLine = sh.match(/^\s*deny='(.*)'$/m);
    const denied = [...denyLine![1]!.matchAll(/"Bash\(([^"]*)\)"/g)].map((m) => m[1]!);
    expect(denied).toContain("pkill:*");
    expect(denied).toContain("killall:*");
    // ps forms that print process environments are denied, and the deny does not catch the rule-15 form
    const glob = (r: string): RegExp => new RegExp("^" + r.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
    const globDenied = (cmd: string): boolean => denied.some((r) => r.includes("*") && !r.endsWith(":*") && glob(r).test(cmd));
    for (const env of ["ps eww", "ps -E", "ps auxe", "ps -ww -E -p 1", "ps -o pid,ppid,stat,lstart,command -p 10436 -e", "ps -o pid,ppid,stat,lstart,command -p 1 e"]) expect([env, globDenied(env)]).toEqual([env, true]);
    expect(globDenied("ps -o pid,ppid,stat,lstart,command -p 10436")).toBe(false);
    // rules are numbered without gaps, so a later edit cannot silently drop one
    const nums = [...INSTRUCTIONS.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });
});
