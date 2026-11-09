// Section 10.2 zero-side-effect strategy for the B1 feasibility library (refs #146): an import-graph test and a
// throwing-stub harness. Synthetic fixtures only; no store, host, network, clock or randomness.

import { describe, expect, test } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { evaluate, validate_report_for_consumption } from "../src/feasibility/evaluate.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const srcDir = path.join(import.meta.dir, "..", "src", "feasibility");
const fixDir = path.join(import.meta.dir, "fixtures", "feasibility");
const BASE: J = JSON.parse(fs.readFileSync(path.join(fixDir, "baseline.json"), "utf8"));
const CASES: J = JSON.parse(fs.readFileSync(path.join(fixDir, "cases.json"), "utf8"));

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
  return out;
}

/** Transitive closure of relative imports from an entry file, plus every external specifier seen. */
function graph(entry: string): { files: string[]; external: string[] } {
  const files: string[] = [];
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (files.includes(f)) continue;
    files.push(f);
    for (const s of specifiers(fs.readFileSync(f, "utf8"))) {
      if (s.startsWith(".")) queue.push(path.resolve(path.dirname(f), s));
      else external.add(s);
    }
  }
  return { files: files.sort(), external: [...external].sort() };
}

describe("import graph", () => {
  const g = graph(path.join(srcDir, "evaluate.ts"));
  test("evaluate.ts reaches only the feasibility modules", () => {
    expect(g.files.map((f) => path.relative(srcDir, f))).toEqual(["canonical.ts", "evaluate.ts", "types.ts"]);
  });
  test("the only external import is the hash primitive", () => {
    expect(g.external).toEqual(["node:crypto"]);
  });
  test("no forbidden module, directly or by dynamic import / require", () => {
    const forbidden = /(^|[:/])(fs|child_process|net|http|https|dgram|tls|dns|worker_threads|os|valkey|store|bridge|channel|cli|publish|handoff)(\.ts|\/|$)|ioredis|redis/;
    for (const f of g.files) {
      for (const s of specifiers(fs.readFileSync(f, "utf8"))) expect(forbidden.test(s)).toBe(false);
    }
  });
  test("no ambient side-effect API appears in the sources", () => {
    const banned = [/Date\.now/, /new Date\(/, /randomUUID/, /Math\.random/, /\bfetch\(/, /process\./, /\bBun\./, /performance\.now/, /setTimeout|setInterval/, /XMLHttpRequest|WebSocket/, /Deno\./, /globalThis/];
    for (const f of g.files) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of banned) expect(`${path.basename(f)} ${re.source}: ${re.test(text)}`).toContain(": false");
    }
  });
  test("the import-graph scanner itself sees a known import (guard against a blind regex)", () => {
    expect(specifiers('import { a } from "./x.ts";\nimport fs from "node:fs";\nconst m = await import("node:net");')).toEqual(["./x.ts", "node:fs", "node:net"]);
    expect(graph(path.join(srcDir, "canonical.ts")).external).toEqual(["node:crypto"]);
  });
});

function applyCase(c: J): { env: J; snap: J; now: number } {
  const root: J = { envelope: structuredClone(BASE.envelope), snapshot: structuredClone(BASE.snapshot), now: BASE.nowMs };
  for (const [p, v] of Object.entries(c.set ?? {})) {
    const segs = p.split(".");
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]!];
    cur[segs[segs.length - 1]!] = structuredClone(v);
  }
  return { env: root.envelope, snap: root.snapshot, now: root.now };
}

describe("throwing stubs", () => {
  test("evaluate and consumption cause no fs/child_process/net/fetch/Date.now/randomUUID/Math.random call", () => {
    // Prepare every input first: fixture loading itself uses fs.
    const prepared = CASES.evaluate.map((c: J) => applyCase(c));
    const hits: string[] = [];
    const saved: [J, string, J][] = [];
    const stub = (obj: J, key: string, label: string): void => {
      if (obj === undefined || obj === null || typeof obj[key] !== "function") return;
      saved.push([obj, key, obj[key]]);
      obj[key] = () => {
        hits.push(label);
        throw new Error(`forbidden effect: ${label}`);
      };
    };
    for (const k of Object.keys(fs)) if (typeof (fs as J)[k] === "function") stub(fs, k, `fs.${k}`);
    for (const k of Object.keys(childProcess)) if (typeof (childProcess as J)[k] === "function") stub(childProcess, k, `child_process.${k}`);
    for (const k of Object.keys(net)) if (typeof (net as J)[k] === "function") stub(net, k, `net.${k}`);
    stub(globalThis, "fetch", "fetch");
    stub(Date, "now", "Date.now");
    stub(Math, "random", "Math.random");
    stub(globalThis.crypto, "randomUUID", "crypto.randomUUID");
    stub(globalThis.crypto, "getRandomValues", "crypto.getRandomValues");
    stub(globalThis, "setTimeout", "setTimeout");
    let outputs = 0;
    let threw: unknown;
    try {
      for (const p of prepared) {
        const r = evaluate(p.env, p.snap, p.now);
        const again = evaluate(p.env, p.snap, p.now);
        if (JSON.stringify(r) !== JSON.stringify(again)) throw new Error("non-deterministic");
        validate_report_for_consumption(r, p.env, p.snap, p.now);
        validate_report_for_consumption(null, p.env, p.snap, p.now);
        outputs += 2;
      }
    } catch (e) {
      threw = e;
    } finally {
      for (const [obj, key, fn] of saved.reverse()) obj[key] = fn;
    }
    expect(threw).toBeUndefined();
    expect(hits).toEqual([]);
    expect(outputs).toBe(CASES.evaluate.length * 2);
    expect(saved.length).toBeGreaterThan(20); // the stubs were really installed
  });

  test("the stubs are effective: a stubbed effect throws and is recorded (harness self-check)", () => {
    const orig = Date.now;
    let hit = 0;
    Date.now = () => {
      hit++;
      throw new Error("x");
    };
    try {
      expect(() => Date.now()).toThrow();
    } finally {
      Date.now = orig;
    }
    expect(hit).toBe(1);
    expect(typeof Date.now()).toBe("number");
  });

  test("the clock is the injected argument only: the same inputs give the same output regardless of wall time", () => {
    const p = applyCase({});
    const r = evaluate(p.env, p.snap, p.now);
    expect(r.evaluated_at_ms).toBe(p.now);
    expect(evaluate(p.env, p.snap, p.now).report_digest).toBe(r.report_digest);
  });
});
