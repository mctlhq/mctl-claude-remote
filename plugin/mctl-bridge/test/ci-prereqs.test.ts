// Several suites skip themselves when a tool is missing. That is right on a laptop and
// wrong in CI: a skipped security test is a guarantee nobody checked (the slot.sh
// mutations once survived because the runner had no zsh). In CI the tools must exist.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, test } from "bun:test";

import { VALKEY_SERVER } from "./support.ts";

function have(name: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!process.env.CI)("the tools the skippable suites need are present in CI", () => {
  expect(VALKEY_SERVER).not.toBeNull();
  expect(have("zsh")).toBe(true);
  expect(fs.existsSync("/usr/bin/python3")).toBe(true);
});
