// The ratchet under `scripts/proto-index.ts`: how many places in each package READ a `Record<…>`
// object literal with a computed key that is not a string literal. The number may FALL and may
// never rise. Data only.
//
// WHY A COUNT AND A SENTENCE. Every site pinned here is a claim that the key cannot be
// `constructor`, `toString` or `__proto__` — usually because its TYPE is a closed union the
// compiler checks. That claim holds exactly until the value arrives from a database row, an HTTP
// header or a JSON body, which is where all thirteen shipped instances came from. The sentence is
// where a human says which side of that line the package's tables sit on.
//
// Shrink it with `bun run scripts/proto-index.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PROTO_PINS_FILE = 'scripts/lib/proto-index-pins.ts';

export interface ProtoIndexPin {
  readonly count: number;
  readonly reason: string;
}

/**
 * Measured 2026-08-23, on the first run: 100 reads across 18 packages, after the sweep that fixed
 * thirteen by hand. The residue is overwhelmingly one shape — a closed-key table indexed by a value
 * whose declared TYPE is the key union — which TypeScript checks and which becomes a defect the day
 * the value stops being typed and starts being parsed.
 */
export const PROTO_INDEX_PINS: Readonly<Record<string, ProtoIndexPin>> = {
  entity: {
    count: 1,
    reason:
      "why: `array-element.ts`'s `fix: ARRAY_ELEMENT_FIXES[kind]` — `kind` reaches it only through `isRefusedElement`'s closed list of four, and `@ultimat3/cli`'s `fix-scan.ts` reads that exact spelling to gate the table's four fix lines; a guard in the expression would drop them from the errors gate (permanent until fix-scan reads a guarded lookup).",
  },
  mail: {
    count: 2,
    reason:
      "why: `errors.ts` `ADDRESS_FIXES[field]` and `smtp-client.ts` `FIXES[stage]` — keys are the closed unions `EnvelopeAddressField` and `SendStage`, and both are fix tables `@ultimat3/cli`'s `fix-scan.ts` reads only as a bare literal read by `fix: TABLE[key]`; a null-prototype build hides 12 fix lines from the errors and fix-prose gates (measured, sweep 8b). Permanent until fix-scan accepts `Object.assign(Object.create(null), {`.",
  },
  // why: 26 -> 27 because core's source-mask now reads past a regex inside a template ${}, which
  // had hidden scripts/side-effects.ts's FINDINGS[gap.kind] — the same shape this row already pins.
  // why: 26 -> 27 again with scripts/health.ts: `judge()` reads ROW_COMMANDS[row], the RowId union
  // that file declares one line above the table.
};
