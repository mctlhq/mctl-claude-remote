// MCTL-CJ1 canonical encoding, strict parsing and domain-separated digests (design section 4,
// docs/dispatch-feasibility-146.md). Pure: only fixture files are read by this harness; the library
// under test reads nothing. Vectors A and B are design vectors, not a cross-language equivalence claim (G6).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { CanonicalError, DOMAINS, canonicalize, digest, digestInput, parseStrict } from "../src/feasibility/canonical.ts";

const VECTOR_A_BODY = '{"a":"é\\"\\u0001","b":[2,1],"c":true}';
const VECTOR_A_SHA = "cf21d3e7ed6c38229e8e4158b19a7c8d0bb0352e7c0a225b3c205ebc35ac3fc9";
const VECTOR_B_BODY =
  '{"advisory":{"est_changed_files":2,"est_minutes":20},"allowed_files":["docs/example-146.md"],"attempt_id":"a-00000000-0000-4000-8000-000000000002","authority_ref":{"id":"decision-0001","kind":"operator_decision"},"base":{"base_sha":"0123456789abcdef0123456789abcdef01234567","branch":"main"},"bounds":{"max_changed_files":3,"max_wall_ms":3600000},"dependencies":[],"expected":{"artifact_kind":"handoff_bundle","branch":"docs/example-146","trailer":"Agent: claude"},"expires_at_ms":1790000000000,"fixtures":["fixture:synthetic-a"],"repo":"example-org/example-repo","required_commands":["cmd:git-diff-check"],"schema":"mctl.task-envelope/1","slot":"slot-x","slot_epoch":"7","task_id":"t-00000000-0000-4000-8000-000000000001","worktree_label":"wt-1"}';
const VECTOR_B_SHA = "43e77d4fafa97cc56fe831d1bdcb145468f821b940bdf1519a074157c9527880";

const SET_FIELDS = new Set(["allowed_files", "required_commands", "fixtures", "mandatory_writes"]);
const opts = { setFields: SET_FIELDS };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CanonicalError);
    return (e as CanonicalError).code;
  }
  return "NO_THROW";
}

const enc = new TextEncoder();

describe("published vectors", () => {
  test("vector A: body bytes, 68-byte digest input, sha256", () => {
    const value = JSON.parse('{"a":"é\\"\\u0001","b":[2,1],"c":true}');
    const body = canonicalize(value);
    expect(body).toBe(VECTOR_A_BODY);
    expect(enc.encode(body).length).toBe(37);
    expect(digestInput("test-vector", body).length).toBe(68);
    expect(digest("test-vector", value)).toBe(VECTOR_A_SHA);
  });

  test("vector B: synthetic envelope body 747 bytes, 780-byte input, sha256", () => {
    const fixture = JSON.parse(fs.readFileSync(new URL("../../../docs/dispatch-feasibility-fixtures-146.json", import.meta.url), "utf8"));
    const envelope = fixture.baseline.task_envelope;
    const body = canonicalize(envelope, opts);
    expect(body).toBe(VECTOR_B_BODY);
    expect(enc.encode(body).length).toBe(747);
    expect(digestInput("task-envelope", body).length).toBe(780);
    expect(digest("task-envelope", envelope, opts)).toBe(VECTOR_B_SHA);
    expect(fixture.baseline.task_envelope_digest).toBe(VECTOR_B_SHA);
  });

  test("vector B also reproduces through the strict raw-text parser", () => {
    const parsed = parseStrict(VECTOR_B_BODY);
    expect(digest("task-envelope", parsed, opts)).toBe(VECTOR_B_SHA);
  });
});

describe("domain separation", () => {
  test("domains are the four fixed ASCII strings", () => {
    expect(DOMAINS).toEqual({
      "task-envelope": "mctl.feasibility/1/task-envelope",
      "capability-snapshot": "mctl.feasibility/1/capability-snapshot",
      report: "mctl.feasibility/1/report",
      "test-vector": "mctl.feasibility/1/test-vector",
    });
  });

  test("same body under different domains gives different digests", () => {
    const v = { x: 1 };
    const all = (Object.keys(DOMAINS) as (keyof typeof DOMAINS)[]).map((d) => digest(d, v));
    expect(new Set(all).size).toBe(4);
  });

  test("digest input is domain || LF || body", () => {
    const input = digestInput("report", "{}");
    expect(new TextDecoder().decode(input)).toBe("mctl.feasibility/1/report\n{}");
  });

  test("unknown domain is rejected", () => {
    // @ts-expect-error deliberately outside the closed set
    expect(codeOf(() => digest("other", {}))).toBe("bad_domain");
  });
});

describe("encoding rules", () => {
  test("object members are in ascending bytewise key order regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2, c: { z: true, y: false } })).toBe('{"a":2,"b":1,"c":{"y":false,"z":true}}');
    expect(canonicalize({ c: 1, b: 2, a: 3 })).toBe(canonicalize({ a: 3, b: 2, c: 1 }));
  });

  test("uppercase keys sort before lowercase (bytewise, not locale)", () => {
    expect(canonicalize({ b: 1, B: 2, _: 3 })).toBe('{"B":2,"_":3,"b":1}');
  });

  test("no whitespace; empty containers", () => {
    expect(canonicalize({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
  });

  test("string escaping: only quote, backslash and U+0000-U+001F; lowercase hex; U+007F and non-ASCII raw", () => {
    expect(canonicalize('"\\')).toBe('"\\"\\\\"');
    expect(canonicalize("\u0000\u001f\n\t\r\b\f")).toBe('"\\u0000\\u001f\\u000a\\u0009\\u000d\\u0008\\u000c"');
    expect(canonicalize("/")).toBe('"/"');
    expect(canonicalize("\u007f")).toBe('"\u007f"');
    expect(canonicalize("é \u{1F600}")).toBe('"é \u{1F600}"');
    expect(canonicalize("\u001a")).toContain("\\u001a");
  });

  test("no Unicode normalization", () => {
    const composed = "é";
    const decomposed = "é";
    expect(canonicalize(composed)).not.toBe(canonicalize(decomposed));
    expect(canonicalize(decomposed)).toBe('"é"');
  });

  test("astral scalars in valid surrogate pairs are accepted", () => {
    expect(canonicalize("\u{10FFFF}")).toBe('"\u{10FFFF}"');
  });

  test("integers: base-10, safe range both ends", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-1)).toBe("-1");
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(canonicalize(-Number.MAX_SAFE_INTEGER)).toBe("-9007199254740991");
  });

  test("booleans", () => {
    expect(canonicalize([true, false])).toBe("[true,false]");
  });

  test("ordered arrays keep order and duplicates; no global sort", () => {
    expect(canonicalize([3, 1, 2, 1])).toBe("[3,1,2,1]");
    expect(canonicalize({ reasons: ["b:x", "a:y", "b:x"] })).toBe('{"reasons":["b:x","a:y","b:x"]}');
    expect(canonicalize({ b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  test("set-valued fields: sorted unique accepted", () => {
    expect(canonicalize({ allowed_files: ["a", "b", "ba"] }, opts)).toBe('{"allowed_files":["a","b","ba"]}');
    expect(canonicalize({ allowed_files: [] }, opts)).toBe('{"allowed_files":[]}');
  });

  test("set-valued fields: unsorted or duplicate input is rejected, never repaired", () => {
    expect(codeOf(() => canonicalize({ allowed_files: ["b", "a"] }, opts))).toBe("unsorted_set");
    expect(codeOf(() => canonicalize({ fixtures: ["a", "a"] }, opts))).toBe("unsorted_set");
  });

  test("set ordering is UTF-8 byte order, not UTF-16 code-unit order", () => {
    // U+FF5E (BMP, UTF-16 0xFF5E) < U+10000 (astral, UTF-16 0xD800..) in code units is false the other way:
    // in UTF-16 the astral sorts first (0xD800 < 0xFF5E); in UTF-8 U+FF5E (ef bd 9e) < U+10000 (f0 90 80 80).
    const bmp = "～";
    const astral = "\u{10000}";
    expect(canonicalize({ fixtures: [bmp, astral] }, opts)).toBe(`{"fixtures":["${bmp}","${astral}"]}`);
    expect(codeOf(() => canonicalize({ fixtures: [astral, bmp] }, opts))).toBe("unsorted_set");
  });

  test("set rule applies at any depth; non-set fields stay ordered arrays; a set field must be an array", () => {
    expect(codeOf(() => canonicalize({ facts: { value: { mandatory_writes: ["z", "a"] } } }, opts))).toBe("unsorted_set");
    expect(canonicalize({ other: ["z", "a"] }, opts)).toBe('{"other":["z","a"]}');
    expect(codeOf(() => canonicalize({ mandatory_writes: { value: 1 } }, opts))).toBe("wrong_type");
    expect(codeOf(() => canonicalize({ mandatory_writes: "a" }, opts))).toBe("wrong_type");
  });

  test("a set field holding non-strings is rejected", () => {
    expect(codeOf(() => canonicalize({ fixtures: [1, 2] }, opts))).toBe("wrong_type");
  });

  test("self-field exclusion: digest ignores the named member, and omission is explicit", () => {
    const base = { a: 1, verdict: "feasible" };
    const withDigest = { ...base, report_digest: "x" };
    expect(canonicalize(withDigest, { exclude: ["report_digest"] })).toBe(canonicalize(base));
    expect(digest("report", withDigest, { exclude: ["report_digest"] })).toBe(digest("report", base));
    expect(digest("report", withDigest)).not.toBe(digest("report", base));
    // other members still count
    expect(digest("report", { ...withDigest, verdict: "busy" }, { exclude: ["report_digest"] })).not.toBe(digest("report", base));
  });

  test("exclusion applies at the top level only", () => {
    expect(canonicalize({ nested: { report_digest: 1 } }, { exclude: ["report_digest"] })).toBe('{"nested":{"report_digest":1}}');
  });
});

describe("canonicalize rejection corpus (typed values)", () => {
  const cases: [string, unknown, string][] = [
    ["null", null, "null_value"],
    ["null member", { a: null }, "null_value"],
    ["undefined", undefined, "wrong_type"],
    ["undefined member", { a: undefined }, "wrong_type"],
    ["float", 1.5, "forbidden_number"],
    ["NaN", Number.NaN, "forbidden_number"],
    ["Infinity", Number.POSITIVE_INFINITY, "forbidden_number"],
    ["negative zero", -0, "forbidden_number"],
    ["unsafe integer", 2 ** 53, "unsafe_integer"],
    ["unsafe negative", -(2 ** 53), "unsafe_integer"],
    ["bigint", 1n, "wrong_type"],
    ["function", () => 1, "wrong_type"],
    ["symbol", Symbol("x"), "wrong_type"],
    ["Date", new Date(0), "wrong_type"],
    ["Map", new Map(), "wrong_type"],
    ["lone high surrogate", "\ud800", "bad_scalar"],
    ["lone low surrogate", "a\udc00b", "bad_scalar"],
    ["reversed surrogates", "\udc00\ud800", "bad_scalar"],
    ["lone surrogate in key", { "\ud800": 1 }, "bad_key"],
    ["non-ASCII key", { é: 1 }, "bad_key"],
    ["sparse array", [1, , 3], "wrong_type"], // eslint-disable-line no-sparse-arrays
  ];
  for (const [name, value, code] of cases) {
    test(`rejects ${name}`, () => {
      expect(codeOf(() => canonicalize(value))).toBe(code);
    });
  }

  test("rejects symbol keys, accessor properties and class instances", () => {
    expect(codeOf(() => canonicalize({ [Symbol("k")]: 1 }))).toBe("wrong_type");
    const acc = {};
    Object.defineProperty(acc, "a", { get: () => 1, enumerable: true });
    expect(codeOf(() => canonicalize(acc))).toBe("wrong_type");
    class C { a = 1; }
    expect(codeOf(() => canonicalize(new C()))).toBe("wrong_type");
  });

  test("rejects cycles and excessive depth without overflowing the stack", () => {
    const cyc: Record<string, unknown> = {};
    cyc.a = cyc;
    expect(codeOf(() => canonicalize(cyc))).toBe("too_deep");
    let deep: unknown = 1;
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(codeOf(() => canonicalize(deep))).toBe("too_deep");
  });

  test("a null-prototype object is accepted like a plain one", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.a = 1;
    expect(canonicalize(o)).toBe('{"a":1}');
  });

  test("__proto__ is an ordinary key when present as an own property", () => {
    const o = JSON.parse('{"__proto__":1,"a":2}');
    expect(canonicalize(o)).toBe('{"__proto__":1,"a":2}');
  });
});

describe("error privacy", () => {
  const SECRET = "SECRET-VALUE-/Users/someone/token=abc";
  test("errors never contain the offending value or arbitrary keys", () => {
    const attempts: (() => unknown)[] = [
      () => canonicalize({ [`k-${SECRET}`]: null }),
      () => canonicalize({ fixtures: [SECRET, "A"] }, opts),
      () => canonicalize({ a: SECRET + "\ud800" }),
      () => canonicalize({ [SECRET]: 1.5 }),
      () => parseStrict(`{"${SECRET}":1,"${SECRET}":2}`),
      () => parseStrict(`{"a":"${SECRET}" 1.5}`),
    ];
    for (const fn of attempts) {
      let message = "";
      let json = "";
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalError);
        const err = e as CanonicalError;
        // Only the fields this library defines; the runtime adds its own source-location properties.
        message = `${err.name}: ${err.message}`;
        json = JSON.stringify({ name: err.name, message: err.message, code: err.code });
        expect(String(err.stack).split("\n")[0]).not.toContain("SECRET");
      }
      expect(message).not.toBe("");
      for (const leak of ["SECRET", "/Users/", "token=", "abc"]) {
        expect(message).not.toContain(leak);
        expect(json).not.toContain(leak);
      }
    }
  });

  test("error carries a closed code only", () => {
    try {
      canonicalize(1.5);
    } catch (e) {
      expect((e as CanonicalError).code).toBe("forbidden_number");
      expect((e as Error).message).toBe("forbidden_number");
    }
  });
});

describe("parseStrict: raw JSON text", () => {
  test("parses the closed subset", () => {
    expect(parseStrict(' { "a" : [ 1 , -2 , true , false , "x" ] , "b" : { } } \n')).toEqual({ a: [1, -2, true, false, "x"], b: {} });
  });

  test("parses \\u escapes including a valid surrogate pair", () => {
    expect(parseStrict('"\\u00e9\\ud83d\\ude00\\n\\/"')).toBe("é\u{1F600}\n/");
  });

  test("__proto__ member becomes an own data property, not a prototype", () => {
    const v = parseStrict('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("duplicate keys are rejected before JSON.parse would silently keep the last", () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 }); // the loss being guarded against
    expect(codeOf(() => parseStrict('{"a":1,"a":2}'))).toBe("duplicate_key");
  });

  test("duplicate keys are detected after escape decoding", () => {
    expect(codeOf(() => parseStrict('{"a":1,"\\u0061":2}'))).toBe("duplicate_key");
  });

  test("duplicate keys are detected in nested objects and arrays of objects", () => {
    expect(codeOf(() => parseStrict('{"x":{"k":1,"k":1}}'))).toBe("duplicate_key");
    expect(codeOf(() => parseStrict('[{"k":1},{"k":1,"k":2}]'))).toBe("duplicate_key");
  });

  test("the same key in sibling objects is fine", () => {
    expect(parseStrict('[{"k":1},{"k":2}]')).toEqual([{ k: 1 }, { k: 2 }]);
  });

  const forbiddenNumbers: [string, string][] = [
    ["decimal fraction", "1.0"],
    ["fraction", "0.5"],
    ["exponent", "1e3"],
    ["exponent upper", "1E3"],
    ["exponent signed", "1e+3"],
    ["negative exponent", "1e-3"],
    ["fraction with exponent", "1.5e2"],
    ["negative zero", "-0"],
    ["negative zero fraction", "-0.0"],
    ["leading zero", "01"],
    ["leading zeros", "007"],
    ["negative leading zero", "-01"],
    ["plus sign", "+1"],
    ["leading dot", ".5"],
    ["trailing dot", "1."],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["negative Infinity", "-Infinity"],
    ["hex", "0x10"],
  ];
  for (const [name, tok] of forbiddenNumbers) {
    test(`rejects ${name} lexical form (${tok})`, () => {
      expect(codeOf(() => parseStrict(tok))).toBe("forbidden_number");
      expect(codeOf(() => parseStrict(`{"a":[${tok}]}`))).toBe("forbidden_number");
    });
  }

  test("1.0 would be silently collapsed by JSON.parse; the strict parser refuses it", () => {
    expect(JSON.parse("1.0")).toBe(1);
    expect(JSON.parse("1e3")).toBe(1000);
    expect(JSON.parse("-0")).toBe(-0);
  });

  test("unsafe integers are rejected by lexical magnitude, before precision loss", () => {
    expect(parseStrict("9007199254740991")).toBe(9007199254740991);
    expect(parseStrict("-9007199254740991")).toBe(-9007199254740991);
    expect(codeOf(() => parseStrict("9007199254740992"))).toBe("unsafe_integer");
    expect(codeOf(() => parseStrict("9007199254740993"))).toBe("unsafe_integer");
    expect(codeOf(() => parseStrict("-9007199254740992"))).toBe("unsafe_integer");
    expect(codeOf(() => parseStrict("123456789012345678901234567890"))).toBe("unsafe_integer");
  });

  test("null is rejected", () => {
    expect(codeOf(() => parseStrict("null"))).toBe("null_value");
    expect(codeOf(() => parseStrict('{"a":null}'))).toBe("null_value");
  });

  test("lone surrogates are rejected, escaped or raw", () => {
    expect(codeOf(() => parseStrict('"\\ud800"'))).toBe("bad_scalar");
    expect(codeOf(() => parseStrict('"\\udc00"'))).toBe("bad_scalar");
    expect(codeOf(() => parseStrict('"\\ud800\\u0041"'))).toBe("bad_scalar");
    expect(codeOf(() => parseStrict('"\\ud800x"'))).toBe("bad_scalar");
    expect(codeOf(() => parseStrict('"\ud800"'))).toBe("bad_scalar");
    expect(codeOf(() => parseStrict('{"\\ud800":1}'))).toBe("bad_scalar");
  });

  const malformed: [string, string][] = [
    ["empty", ""],
    ["whitespace only", "  "],
    ["trailing garbage", "1 2"],
    ["trailing comma object", '{"a":1,}'],
    ["trailing comma array", "[1,]"],
    ["missing colon", '{"a" 1}'],
    ["unquoted key", "{a:1}"],
    ["single quotes", "{'a':1}"],
    ["unterminated string", '"abc'],
    ["unterminated object", '{"a":1'],
    ["unterminated array", "[1"],
    ["raw control char in string", '"a\u0001b"'],
    ["raw newline in string", '"a\nb"'],
    ["bad escape", '"\\x41"'],
    ["short unicode escape", '"\\u00"'],
    ["non-hex unicode escape", '"\\u00zz"'],
    ["comment", "/* c */ 1"],
    ["BOM", "﻿1"],
    ["bare word", "tru"],
    ["non-string key", "{1:2}"],
    ["NUL byte", "\u0000"],
  ];
  for (const [name, text] of malformed) {
    test(`rejects malformed text: ${name}`, () => {
      expect(codeOf(() => parseStrict(text))).toBe("bad_json");
    });
  }

  test("depth limit is enforced without stack overflow", () => {
    expect(codeOf(() => parseStrict("[".repeat(10000) + "]".repeat(10000)))).toBe("too_deep");
  });

  test("non-string input is rejected", () => {
    // @ts-expect-error
    expect(codeOf(() => parseStrict(5))).toBe("wrong_type");
  });

  test("parse then canonicalize round-trips whitespace and key order differences to the same bytes", () => {
    const a = canonicalize(parseStrict('{ "b" : [2,1],\n "a" : "x" }'));
    const b = canonicalize(parseStrict('{"a":"x","b":[2,1]}'));
    expect(a).toBe(b);
    expect(a).toBe('{"a":"x","b":[2,1]}');
  });
});

describe("parseStrict: object key ASCII rule matches canonicalize", () => {
  const keyCases: [string, string][] = [
    ["raw accented key", '{"é":1}'],
    ["escaped accented key", '{"\\u00e9":1}'],
    ["raw astral key", '{"\u{1F600}":1}'],
    ["escaped astral key", '{"\\ud83d\\ude00":1}'],
    ["nested object key", '{"a":{"é":1}}'],
    ["key inside array of objects", '[{"a":1},{"\\u00e9":2}]'],
    ["deep nested key", '{"a":[{"b":{"\u{1F600}":true}}]}'],
  ];
  for (const [name, text] of keyCases) {
    test(`rejects ${name} with bad_key`, () => {
      expect(codeOf(() => parseStrict(text))).toBe("bad_key");
    });
  }

  test("bad_key error does not leak the key", () => {
    try {
      parseStrict('{"SECRET-é":1}');
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalError);
      expect((e as CanonicalError).message).toBe("bad_key");
    }
  });

  test("non-ASCII string VALUES are still accepted, and ASCII escaped keys still decode", () => {
    expect(parseStrict('{"a":"é\u{1F600}","b":["\\u00e9"]}')).toEqual({ a: "é\u{1F600}", b: ["é"] });
    expect(parseStrict('{"\\u0061":1}')).toEqual({ a: 1 });
  });

  test("parser and encoder agree on a non-ASCII key", () => {
    expect(codeOf(() => canonicalize({ é: 1 }))).toBe("bad_key");
    expect(codeOf(() => parseStrict('{"é":1}'))).toBe("bad_key");
  });
});

describe("shared depth rule: at most MAX_DEPTH (64) nested containers", () => {
  type Kind = "a" | "o";
  const pattern = (name: string, n: number): Kind[] => {
    const out: Kind[] = [];
    for (let i = 0; i < n; i++) out.push(name === "array" ? "a" : name === "object" ? "o" : i % 2 === 0 ? "a" : "o");
    return out;
  };
  // innermost container holds `leaf` (undefined = empty container)
  const buildText = (kinds: Kind[], leaf: string | undefined): string => {
    let s = "";
    for (let i = kinds.length - 1; i >= 0; i--) {
      const inner = i === kinds.length - 1 ? leaf : s;
      s = kinds[i] === "a" ? `[${inner ?? ""}]` : inner === undefined ? "{}" : `{"k":${inner}}`;
    }
    return s;
  };
  const buildValue = (kinds: Kind[], leaf: unknown): unknown => {
    let v: unknown = leaf;
    for (let i = kinds.length - 1; i >= 0; i--) {
      const empty = i === kinds.length - 1 && leaf === undefined;
      v = kinds[i] === "a" ? (empty ? [] : [v]) : empty ? {} : { k: v };
    }
    return v;
  };

  for (const shape of ["array", "object", "mixed"]) {
    for (const [leafName, leafText, leafValue] of [
      ["empty", undefined, undefined],
      ["primitive", "1", 1],
    ] as const) {
      test(`${shape} nesting, ${leafName} innermost: 64 accepted and round-trips`, () => {
        const kinds = pattern(shape, 64);
        const text = buildText(kinds, leafText);
        const parsed = parseStrict(text);
        expect(canonicalize(parsed)).toBe(text);
        expect(canonicalize(buildValue(kinds, leafValue))).toBe(text);
      });
      test(`${shape} nesting, ${leafName} innermost: 65 rejected by parser and encoder with too_deep`, () => {
        const kinds = pattern(shape, 65);
        expect(codeOf(() => parseStrict(buildText(kinds, leafText)))).toBe("too_deep");
        expect(codeOf(() => canonicalize(buildValue(kinds, leafValue)))).toBe("too_deep");
      });
    }
  }

  test("a primitive inside the 64th container is allowed; a 65th empty container is not", () => {
    expect(canonicalize(buildValue(pattern("array", 64), "x"))).toBe(buildText(pattern("array", 64), '"x"'));
    expect(codeOf(() => canonicalize(buildValue(pattern("array", 64), []))) ).toBe("too_deep");
    expect(codeOf(() => canonicalize(buildValue(pattern("object", 64), {})))).toBe("too_deep");
  });
});

describe("object own-property hardening", () => {
  test("non-enumerable own data key is rejected, not silently omitted", () => {
    const o: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o, "hidden", { value: 2, enumerable: false, configurable: true, writable: true });
    expect(codeOf(() => canonicalize(o))).toBe("wrong_type");
    expect(codeOf(() => canonicalize({ x: [o] }))).toBe("wrong_type");
    expect(codeOf(() => digest("report", o))).toBe("wrong_type");
  });

  test("non-enumerable getter is rejected and never invoked", () => {
    let calls = 0;
    const o: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o, "hidden", {
      enumerable: false,
      get() {
        calls++;
        return 1;
      },
    });
    expect(codeOf(() => canonicalize(o))).toBe("wrong_type");
    expect(codeOf(() => canonicalize({ n: o }))).toBe("wrong_type");
    expect(calls).toBe(0);
  });

  test("non-enumerable key on a null-prototype object is rejected", () => {
    const o = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(o, "h", { value: 1, enumerable: false });
    expect(codeOf(() => canonicalize(o))).toBe("wrong_type");
  });

  test("ordinary, null-prototype and frozen objects still encode", () => {
    const np = Object.create(null) as Record<string, unknown>;
    np.b = 1;
    np.a = 2;
    expect(canonicalize(np)).toBe('{"a":2,"b":1}');
    expect(canonicalize(Object.freeze({ b: Object.freeze({ d: 1, c: 2 }), a: 1 }))).toBe('{"a":1,"b":{"c":2,"d":1}}');
  });

  test("top-level exclusion still works and does not read the excluded member", () => {
    let calls = 0;
    const o: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o, "report_digest", {
      enumerable: false,
      get() {
        calls++;
        return "x";
      },
    });
    expect(canonicalize(o, { exclude: ["report_digest"] })).toBe('{"a":1}');
    expect(calls).toBe(0);
  });

  test("exclusion does not extend to nested data or hide other hidden keys", () => {
    const nested: Record<string, unknown> = { a: 1 };
    Object.defineProperty(nested, "report_digest", { value: "x", enumerable: false });
    expect(codeOf(() => canonicalize({ n: nested }, { exclude: ["report_digest"] }))).toBe("wrong_type");
    const top: Record<string, unknown> = { a: 1 };
    Object.defineProperty(top, "other", { value: "x", enumerable: false });
    expect(codeOf(() => canonicalize(top, { exclude: ["report_digest"] }))).toBe("wrong_type");
  });
});

describe("parseStrict: negative non-finite tokens", () => {
  test("-NaN is forbidden_number like NaN, Infinity and -Infinity", () => {
    for (const tok of ["NaN", "Infinity", "-Infinity", "-NaN"]) {
      expect(codeOf(() => parseStrict(tok))).toBe("forbidden_number");
      expect(codeOf(() => parseStrict(`{"a":[${tok}]}`))).toBe("forbidden_number");
    }
  });

  test("other malformed tokens stay bad_json", () => {
    for (const tok of ["-nan", "-NaNx", "-Nope", "-", "-N", "NaNx"]) {
      expect(codeOf(() => parseStrict(tok))).toBe("bad_json");
    }
  });
});

describe("determinism and immutability", () => {
  const envelope = () => ({
    z: [3, 1, 2],
    a: { y: "é", x: true },
    allowed_files: ["a", "b"],
  });

  test("identical bytes across repeated runs and permuted insertion order", () => {
    const one = canonicalize(envelope(), opts);
    const two = canonicalize(envelope(), opts);
    const permuted = canonicalize({ allowed_files: ["a", "b"], a: { x: true, y: "é" }, z: [3, 1, 2] }, opts);
    expect(two).toBe(one);
    expect(permuted).toBe(one);
    expect(digest("report", envelope(), opts)).toBe(digest("report", { allowed_files: ["a", "b"], a: { x: true, y: "é" }, z: [3, 1, 2] }, opts));
  });

  test("does not mutate its input and accepts deeply frozen input", () => {
    const v = envelope();
    const before = JSON.stringify(v);
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === "object") {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze((o as Record<string, unknown>)[k]);
      }
    };
    deepFreeze(v);
    const out = canonicalize(v, opts);
    expect(JSON.stringify(v)).toBe(before);
    expect(out).toBe(canonicalize(envelope(), opts));
    // digest hashing the input object before/after
    expect(digest("report", v, opts)).toBe(digest("report", envelope(), opts));
    expect(JSON.stringify(v)).toBe(before);
  });

  test("digest is lowercase hex sha256", () => {
    expect(digest("test-vector", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("array own-property hardening", () => {
  function withGetter(): { arr: unknown[]; calls: () => number } {
    let n = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      enumerable: true,
      configurable: true,
      get() {
        n++;
        return n;
      },
    });
    return { arr, calls: () => n };
  }

  test("enumerable index getter is rejected with zero getter calls", () => {
    const { arr, calls } = withGetter();
    expect(codeOf(() => canonicalize(arr))).toBe("wrong_type");
    expect(codeOf(() => canonicalize({ a: arr }))).toBe("wrong_type");
    expect(codeOf(() => digest("report", arr))).toBe("wrong_type");
    expect(calls()).toBe(0);
  });

  test("getter on a later index, and setter-only index, are rejected without invoking", () => {
    let n = 0;
    const arr: unknown[] = [1, 2];
    Object.defineProperty(arr, 1, {
      enumerable: true,
      configurable: true,
      get() {
        n++;
        return 2;
      },
    });
    expect(codeOf(() => canonicalize(arr))).toBe("wrong_type");
    const s: unknown[] = [];
    Object.defineProperty(s, 0, { enumerable: true, configurable: true, set() { n++; } });
    expect(codeOf(() => canonicalize(s))).toBe("wrong_type");
    expect(n).toBe(0);
  });

  test("accessor arrays can never change bytes between calls", () => {
    const { arr } = withGetter();
    const outcomes = [0, 1, 2].map(() => codeOf(() => canonicalize(arr)));
    expect(outcomes).toEqual(["wrong_type", "wrong_type", "wrong_type"]);
  });

  test("error is closed and sanitized", () => {
    const { arr } = withGetter();
    try {
      canonicalize(arr);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalError);
      expect((e as CanonicalError).message).toBe("wrong_type");
      expect((e as CanonicalError).code).toBe("wrong_type");
      expect(Object.keys(e as object).sort()).toEqual(["code", "name"]);
    }
  });

  test("non-enumerable index data property, sparse holes and non-index extras are rejected", () => {
    const hidden: unknown[] = [1];
    Object.defineProperty(hidden, 0, { value: 1, enumerable: false, configurable: true, writable: true });
    expect(codeOf(() => canonicalize(hidden))).toBe("wrong_type");
    expect(codeOf(() => canonicalize([1, , 3]))).toBe("wrong_type"); // eslint-disable-line no-sparse-arrays
    const extra = [1, 2] as unknown[] & { x?: number };
    extra.x = 1;
    expect(codeOf(() => canonicalize(extra))).toBe("wrong_type");
    const hiddenExtra = [1, 2] as unknown[];
    Object.defineProperty(hiddenExtra, "x", { value: 1, enumerable: false });
    expect(codeOf(() => canonicalize(hiddenExtra))).toBe("wrong_type");
    // key count equals length but one index is missing and a non-index key stands in
    const swapped = [1, 2, 3] as unknown[] & { x?: number };
    delete (swapped as unknown[])[1];
    swapped.x = 9;
    expect(codeOf(() => canonicalize(swapped))).toBe("wrong_type");
  });

  test("ordinary and frozen dense data arrays keep their bytes", () => {
    expect(canonicalize([2, 1, "a", true, [3], { b: 1 }])).toBe('[2,1,"a",true,[3],{"b":1}]');
    expect(canonicalize([])).toBe("[]");
    const frozen = Object.freeze([2, 1, Object.freeze(["x"])]);
    expect(canonicalize(frozen)).toBe("[2,1,[\"x\"]]");
    expect(canonicalize(frozen)).toBe(canonicalize(frozen));
    expect(canonicalize({ allowed_files: Object.freeze(["a", "b"]) }, opts)).toBe('{"allowed_files":["a","b"]}');
  });

  test("array with enumerable Symbol property is rejected like plain objects", () => {
    const arr: unknown[] = [1];
    (arr as unknown as Record<symbol, unknown>)[Symbol("s")] = 1;
    expect(codeOf(() => canonicalize(arr))).toBe("wrong_type");
    const o = { a: 1 } as Record<string | symbol, unknown>;
    o[Symbol("s")] = 1;
    expect(codeOf(() => canonicalize(o))).toBe("wrong_type");
  });

  test("array with non-enumerable Symbol property is rejected", () => {
    const arr: unknown[] = [1];
    Object.defineProperty(arr, Symbol("h"), { value: 1, enumerable: false });
    expect(codeOf(() => canonicalize(arr))).toBe("wrong_type");
  });

  test("Symbol rejection precedes element encoding: index getter not invoked", () => {
    for (const enumerable of [true, false]) {
      const { arr, calls } = withGetter();
      Object.defineProperty(arr, Symbol("s"), { value: 1, enumerable });
      expect(codeOf(() => canonicalize(arr))).toBe("wrong_type");
      expect(calls()).toBe(0);
    }
  });
});
