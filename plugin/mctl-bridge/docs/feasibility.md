# Feasibility library (B1, refs #146)

Pure library in `src/feasibility/`: `canonical.ts` (MCTL-CJ1 encoder, strict parser, digest), `types.ts`
(closed schemas, enums, code table), `evaluate.ts` (`evaluate(envelope, snapshot, nowMs)` and
`validate_report_for_consumption(report, envelope, snapshot, nowMs)`).

Design: `docs/dispatch-feasibility-146.md` (sections 3-10, 13, 14). Tests: `test/feasibility-*.test.ts`,
synthetic fixtures in `test/fixtures/feasibility/`.

- Both functions take plain objects and an integer clock and have no side effects (import-graph and
  throwing-stub tests in `feasibility-purity.test.ts`).
- Malformed envelope, snapshot or clock throws a sanitized `FeasibilityInputError` `{input, code, path}`.
  A presented report that is malformed returns the fixed schema-fail consumption result.
- A report, a digest or `valid: true` is **not** authorization, a reservation, OS-isolation evidence, proof
  of authenticity or a TOCTOU closure. Nothing in the bridge calls this library (no B2 enforcement).
- The matcher attestation is an injected fact checked for structure and binding only; no real provider or
  machine readiness is claimed.
