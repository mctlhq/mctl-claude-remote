// Compiles src/ into dist/, which is committed: an installed plugin runs
// dist/*.js with plain `node` and nothing is built on the user's machine.
//
//   node scripts/build.mjs          rebuild dist/
//   node scripts/build.mjs --check  fail if dist/ differs from a fresh build

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.resolve(root, "..", "node_modules", "typescript", "bin", "tsc");
const check = process.argv.includes("--check");

function build(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.json"), "--outDir", outDir], {
    stdio: "inherit",
  });
  // dist/ sits outside any package.json with "type": "module"; this keeps the
  // compiled files ES modules wherever the plugin is installed.
  fs.writeFileSync(path.join(outDir, "package.json"), '{\n  "type": "module"\n}\n');
}

function listing(dir) {
  const out = new Map();
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const dist = path.join(root, "dist");
if (!check) {
  build(dist);
} else {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "mctl-events-dist-"));
  try {
    build(fresh);
    const want = listing(fresh);
    const have = listing(dist);
    const stale = [...new Set([...want.keys(), ...have.keys()])]
      .filter((name) => !want.has(name) || !have.has(name) || !want.get(name).equals(have.get(name)))
      .sort();
    if (stale.length) {
      console.error(`dist/ does not match a fresh build of src/: ${stale.join(", ")}`);
      console.error("Run `npm run build` in plugin/ and commit dist/.");
      process.exit(1);
    }
    console.log(`dist/ matches a fresh build (${want.size} files)`);
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
}
