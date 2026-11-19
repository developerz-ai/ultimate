// The bounds a tier's constructor screens besides its TTL: a ceiling (bytes or entries), a
// millisecond duration, the semantic tier's similarity floor. Split from `tiers.ts` (its 500-line
// ceiling); `assertTtl` and the jitter screen stay there, beside the lease they apply.

import { CacheLimitInvalidError } from './errors';
import type { TtlScope } from './tiers';

/**
 * A tier's ceiling — bytes or entries — screened where it is still nameable. The same rule as
 * `assertTtl` in `tiers.ts`, over the other knob a tier's constructor takes. A SEPARATE refusal
 * from `X_CACHE_TOO_LARGE`, which is one entry against a valid ceiling: this one is the ceiling
 * itself, and it needs a screen because a bad ceiling refuses nothing and evicts nothing rather
 * than refusing everything. `NaN > x` and `x > NaN` are both false.
 */
export function assertFiniteCapacity(tier: TtlScope, option: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new CacheLimitInvalidError({
    tier,
    option,
    value,
    expected: 'a whole number greater than zero',
    example: '10_000',
  });
}

/**
 * A millisecond duration: a driver's request budget (handed to `AbortSignal.timeout`, which THROWS
 * on a non-finite one — inside `purgePost`'s try, so the config typo came back as a retryable
 * transport failure that never happened) and a tier's own `defaultTtlMs`, which is otherwise only
 * screened by `assertTtl` at the first `set`, one write into the process's life.
 *
 * The `Finite` in all three names here is NOT load-bearing, `As of 2026-08-26`. It was: a name
 * regex meant `assertCapacity` and `assertTimeoutMs` left all nine of this package's options
 * reading as unchecked while every one of them was screened. `bun run finite-bounds` now reads
 * `SCREENING_CALLEES` in `scripts/lib/finite-screens.ts` — rename freely, move the rows.
 */
export function assertFiniteDurationMs(tier: string, option: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new CacheLimitInvalidError({
    tier,
    option,
    value,
    expected: 'a whole number of milliseconds greater than zero',
    example: '60_000',
  });
}

/**
 * The similarity floor the semantic tier decides "same question" with — a correctness boundary,
 * not a tuning knob, so `NaN` here does not loosen it, it removes it: `similarity < NaN` is false
 * for every record. Cosine similarity is in [-1, 1] and a floor of 0 already admits an orthogonal
 * vector, so anything outside [0, 1] is a number nobody can have meant.
 */
export function assertFiniteSimilarityFloor(
  tier: TtlScope,
  option: string,
  value: number,
  /** Passed only where the value is a CALL argument rather than a factory option. */
  source?: string | undefined,
): number {
  if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw new CacheLimitInvalidError({
    tier,
    option,
    value,
    expected: 'a number from 0 to 1',
    example: '0.92',
    source,
  });
}
