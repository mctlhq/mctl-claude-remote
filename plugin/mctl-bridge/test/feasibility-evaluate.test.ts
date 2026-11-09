// Unblocked B1 slice only: A1 path grammar, membership and scope intersection (design 13.1, refs #146).
// The evaluator, schema validators and consumption function are held on open design gaps; no test here
// asserts a guessed schema boundary.

import { describe, expect, test } from "bun:test";

import { PathGrammarError, normalizePattern, patternsIntersect, patternMatches } from "../src/feasibility/evaluate.ts";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PathGrammarError);
    return (e as PathGrammarError).code;
  }
  throw new Error("expected throw");
}

describe("A1 grammar", () => {
  test("valid forms and alias normal form", () => {
    expect(normalizePattern("docs/example-146.md")).toEqual({ kind: "exact", segs: ["docs", "example-146.md"] });
    expect(normalizePattern("docs/")).toEqual({ kind: "dir", segs: ["docs"] });
    expect(normalizePattern("docs/**")).toEqual({ kind: "dir", segs: ["docs"] });
    expect(normalizePattern("a/b/**")).toEqual(normalizePattern("a/b/"));
  });
  test.each(["/etc/x", "docs/../x", "docs//x", "docs/./x", "docs\\x", "docs/*.md", "docs/**/x", "**", "***", "a/***", "", "C:/x", "a/\u0000", "a/?", "a/[", "a/{", "/**"])(
    "rejects %j",
    (p) => {
      expect(code(() => normalizePattern(p))).toBe("bad_path_grammar");
    },
  );
  test("non-string rejected without echo", () => {
    expect(code(() => normalizePattern(42 as unknown as string))).toBe("bad_path_grammar");
  });
});

describe("A1 membership", () => {
  test("dir proper prefix, boundary, exact only itself", () => {
    expect(patternMatches("docs/", "docs/a.md")).toBe(true);
    expect(patternMatches("docs/", "docs-x/a.md")).toBe(false);
    expect(patternMatches("docs/", "docs")).toBe(false);
    expect(patternMatches("docs/**", "docs/a/b")).toBe(true);
    expect(patternMatches("a/b", "a/b")).toBe(true);
    expect(patternMatches("a/b", "a/b/c")).toBe(false);
  });
  test("tested path must be an exact path", () => {
    expect(code(() => patternMatches("docs/", "docs/"))).toBe("bad_path_grammar");
  });
});

describe("A1 intersection (every pair, both orders)", () => {
  const cases: [string, string, boolean][] = [
    ["a/b", "a/b", true],
    ["a/b", "a/c", false],
    ["a", "a/b", false],
    ["a", "a/", false],
    ["a/b", "a/", true],
    ["a/", "a/", true],
    ["a/", "a/**", true],
    ["a/", "a/b/", true],
    ["a/", "ab/", false],
    ["ab", "a/", false],
    ["a/b/", "a", false],
    ["docs/", "docs/secret/", true],
  ];
  test.each(cases)("%s vs %s = %p", (p, q, want) => {
    expect(patternsIntersect(p, q)).toBe(want);
    expect(patternsIntersect(q, p)).toBe(want);
  });
});
