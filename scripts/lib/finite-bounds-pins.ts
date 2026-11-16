// The ratchet under `scripts/finite-bounds.ts`: how many numeric options each package defaults
// with `??` and never checks for finiteness. The number may FALL and may never rise. Data only.
//
// WHY A COUNT AND A SENTENCE. Every site pinned here is a claim that the number cannot arrive as
// `NaN` or `±Infinity` — which holds exactly until it comes from `Number(process.env.X)`, a
// `parseInt`, a JSON body or an untyped config file. The sentence is where a human says which side
// of that line the package's options sit on, and says so out loud when the answer is "nobody has
// looked yet". A pin with no sentence is a debt nobody can pay, because nobody knows what it is.
//
// Shrink it with `bun run scripts/finite-bounds.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const FINITE_BOUNDS_PINS_FILE = 'scripts/lib/finite-bounds-pins.ts';

export interface FiniteBoundPin {
  readonly count: number;
  readonly reason: string;
}

/**
 * Measured against a tree in which **tiers 0 through 3** are repaired — the first two slices of the
 * 17.0.0 sweep. A repaired package is ABSENT from this table rather than pinned at zero, and that
 * absence is the machine-checkable claim that its slice closed all of it: `core`, `schema`, `db`,
 * `cache`, `storage`, `time`, `money`, `i18n`, `seo`, `flags` (tier 0–1, 2026-08-26), then `entity`,
 * `policy`, `http`, `auth`, `action`, `query`, `jobs`, `realtime` (tier 2–3). 129 sites → 59.
 *
 * What remains is tier 4 and tier 5, and every count below FALLS as those land. That is the ratchet
 * working, not drift: `X_FINITE_BOUND_PIN_STALE` fires the moment a slice repairs a package and
 * leaves its row behind, so each slice is forced to lower its own rows in the same commit.
 * `scripts/finite-bounds.test.ts` holds the other half — it names every swept package, and a name
 * may only ever be added there.
 *
 * The class was found by hand three times in one day before this file existed: `@ultimat3/ai`'s
 * `chunk({ size: NaN })` (a SYNCHRONOUS infinite loop, past every `AbortSignal`, past the job
 * timeout, on the worker's only thread) and `hive({ concurrency: NaN })` (`Array.from({ length:
 * NaN })` is `[]`, so zero workers ran and the result reported clean success over an array of
 * holes), then six more across `jobs` and `realtime`. That is the same three-strikes bar
 * `config-readers`, `proto-index`, `flight-copies` and `sql-literal-copies` were each written at.
 */
export const FINITE_BOUNDS_PINS: Readonly<Record<string, FiniteBoundPin>> = {
  ui: {
    count: 2,
    reason:
      "why: `Combobox.tsx`'s `debounceMs` and `Section.tsx`'s `level` are screened ONE HOP AWAY, which this rule cannot see (its blind spot 3): `debounce()` throws `X_UI_INVALID_VALUE` for a non-finite delay and `headingTag()` for a level off 1-6, so a second screen at the prop would give one value two codes (`file-controls.test.ts`, `layout.test.ts`). `Textarea.tsx`'s `rows` was screened in plan 101b sweep 8b.",
  },
};
