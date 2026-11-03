// mctl-bridge ships as its own plugin directory, so it carries a copy of the
// mctl-events Valkey client instead of importing across plugins. The copy must
// not drift.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("src/valkey.ts is byte-identical to mctl-events", () => {
  const ours = fs.readFileSync(path.join(here, "..", "src", "valkey.ts"));
  const theirs = fs.readFileSync(path.join(here, "..", "..", "mctl-events", "src", "valkey.ts"));
  expect(ours.equals(theirs)).toBe(true);
});
