// What `scripts/finite-bounds.ts` accepts as the screen on a `??`-defaulted number: a DECLARED
// table of callees, and the one pattern built from it. Data, plus the regex that is only its
// spelling.
//
// WHY DECLARED AND NOT A NAME PATTERN. The rule used to recognise a repair by the callee's NAME —
// `Number.is*`, or any identifier carrying `Finite` — which is the trap this repo has already
// written up twice: a rule spelled `RENDER_MODES` read straight past a copy called `PwaRenderMode`,
// and a duration rule spelled by name would have missed three parsers called `toMs`. Here it cost
// both directions:
//
//   A CORRECT SCREEN READ AS ABSENT. `packages/jobs` folded its screens inward into a helper called
//   `toMs` and four sites in a package pinned at 0 went red — strictly better code, refused by a
//   regex. The three ways out were a redundant outer wrapper naming the same knob twice, hoisting
//   the `??` out of the call (the evasion this rule exists to refuse), or a rename. It renamed.
//   THREE SHIPPED FILES now carry a comment saying the spelling is load-bearing —
//   `packages/jobs/src/clock.ts`, `packages/auth/src/policy-numbers.ts` and
//   `packages/cache/src/tiers.ts` ("the `Finite` in all three names here is load-bearing"). A gate
//   that dictates identifiers in three packages is a gate designing the code.
//
//   A NON-SCREEN READ AS A REPAIR. `InfiniteScroll(` matched `[\w$]*[Ff]inite[\w$]*` — a SolidJS
//   component that screens nothing was a repair span, and any bound inside its call was silenced.
//
// WHY NOT DERIVED FROM SHAPE, which is what every sibling rule here does. It was tried and
// MEASURED, 2026-08-26: "a function whose body calls a screen is a screen" closes over the corpus
// to **4,062 names**, because `AdminLayout` calls `finiteCount` and then everything that renders
// `AdminLayout` inherits it. Bounding it at one hop is worse than the name rule — it drops
// `finiteDurationMs`, which delegates to `finiteOption` — and the property that actually separates
// the two populations is "does this function's CONTRACT refuse a bad number", which is a type
// question no text scan answers. So the honest form is a list a human maintains, like
// `FLOOR_ABOVE` in `scripts/lib/tiers.ts`: one row, one sentence, added in review.
//
// AN UNKNOWN CALLEE IS REPORTED, NOT ACCEPTED. Silence would make every unrecognised wrapper a
// repair, which is `Math.max(1, options.perSecond ?? 500)` passing — the exact defect this rule was
// written for. The cost is one row when a package adds a screening helper, and
// `X_FINITE_BOUND_UNCHECKED`'s `fix:` names that row as the second of its two edits.

/** Where the table lives, so a finding can name the file to edit. */
export const FINITE_SCREENS_FILE = 'scripts/lib/finite-screens.ts';

export interface FiniteScreen {
  /** The callee as it is written at a call site. A dotted name is matched whole. */
  readonly callee: string;
  /** What it refuses, in one sentence — and where it is declared. */
  readonly screens: string;
}

/**
 * Every call this tree may write instead of an inline `Number.isFinite`. Sorted primitives first,
 * then by callee, so a diff adding one is a single line in a predictable place.
 *
 * `scripts/finite-bounds.test.ts` holds the other half: every row must name a function this corpus
 * declares, so a row left behind by a deleted helper is a failing test rather than a rule quietly
 * in force over nothing — the same staleness `X_TIER_FLOOR_STALE` refuses for `FLOOR_ABOVE`.
 */
export const SCREENING_CALLEES: readonly FiniteScreen[] = [
  {
    callee: 'Number.isFinite',
    screens:
      'the irreducible one: false for NaN and for ±Infinity, which is the whole defect class',
  },
  {
    callee: 'Number.isSafeInteger',
    screens: 'the irreducible one where the number COUNTS things — rows, bytes, slots, attempts',
  },
  {
    callee: 'Number.isInteger',
    screens: 'the irreducible one where a fraction is the defect and 2^53 is out of reach anyway',
  },
  {
    callee: 'assertFiniteAuthCount',
    screens:
      'auth/src/policy-numbers.ts — a millisecond TTL or an attempt count, against a minimum',
  },
  {
    callee: 'assertFiniteBodyLimit',
    screens: 'http/src/webhook-verify.ts — the byte ceiling a webhook body is read against',
  },
  {
    callee: 'assertFiniteCapacity',
    screens: 'cache/src/tiers.ts — a tier ceiling, where a bad one evicts nothing rather than all',
  },
  {
    callee: 'assertFiniteCount',
    screens: 'http/src/config.ts — a whole count off `app.config.ts`, parsed before it is believed',
  },
  {
    callee: 'assertFiniteDurationMs',
    screens: "cache/src/tiers.ts — a driver's request budget, which AbortSignal.timeout throws on",
  },
  {
    callee: 'assertFiniteImageQuality',
    screens: 'core/src/image/pipeline.ts — the encoder quality, which has a real 1-100 range',
  },
  {
    callee: 'assertFiniteKeyCap',
    screens: 'http/src/rate-limit.ts — the key ceiling, where NaN makes the limiter unbounded',
  },
  {
    callee: 'assertFiniteLimits',
    screens: 'ai/src/budget.ts — every field of a BudgetLimits at once, at the boundary it guards',
  },
  {
    callee: 'assertFiniteOtlpBound',
    screens: 'core/src/otlp.ts — an exporter bound, where NaN is an export that never batches',
  },
  {
    callee: 'assertFinitePageSize',
    screens: 'entity/src/plan.ts — the row limit, where `slice(0, NaN)` is a page of nothing',
  },
  {
    callee: 'assertFiniteSimilarityFloor',
    screens:
      'cache/src/tiers.ts — the semantic floor, where NaN deletes the boundary rather than moves it',
  },
  {
    callee: 'assertFiniteToleranceMs',
    screens: 'http/src/webhook-verify.ts — the replay window a signature timestamp is judged in',
  },
  {
    callee: 'finite',
    screens: 'core/src/metrics.ts and scraping/src/capture-clip.ts — a recorded value, a clip edge',
  },
  {
    callee: 'finiteCount',
    screens:
      'core/src/finite-option.ts — Number.isSafeInteger plus the minimum only a caller knows',
  },
  {
    callee: 'finiteDeltaSeconds',
    screens: 'http/src/response.ts — a Cache-Control delta, dropped with a warning when it is not',
  },
  {
    callee: 'finiteDurationMs',
    screens: 'jobs/src/clock.ts — a duration in either notation, delegating to finiteOption',
  },
  {
    callee: 'finiteOption',
    screens:
      'core/src/finite-option.ts — the framework-wide refusal, tier 0, for any numeric option',
  },
  {
    callee: 'finiteStatus',
    screens:
      'render/src/finite-status.ts — an HTTP status, which new Response() throws a RangeError on',
  },
];

/**
 * The call shape for a table, in one alternation — never hand-written, so a row and the pattern
 * can never disagree. A dotted callee is escaped whole; a bare one takes a `\b`, so `myfinite(`
 * and `InfiniteScroll(` are not it.
 *
 * Takes the table rather than closing over it so a test can prove the recogniser reads the ROW and
 * not the spelling: a table whose only row is `toMs` must recognise `toMs(…)`, which is the site
 * the name pattern refused and the rename it forced.
 */
export const screeningCallPattern = (callees: readonly FiniteScreen[]): RegExp =>
  new RegExp(
    `(?:${callees
      .map(({ callee }) => (callee.includes('.') ? RegExp.escape(callee) : `\\b${callee}`))
      .join('|')})\\s*\\(`,
    'g',
  );

/** What `scripts/finite-bounds.ts` reads, for the table this repo actually declares. */
export const SCREENING_CALL: RegExp = screeningCallPattern(SCREENING_CALLEES);
