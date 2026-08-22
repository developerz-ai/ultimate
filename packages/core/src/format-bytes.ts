// Single responsibility: a byte count as the short, machine-ish string an error message carries.
//
// Tier 0 because two tier-4 packages need exactly this and neither may import the other:
// `@ultimat3/render`'s `X_BUDGET_EXCEEDED` cause and `@ultimat3/pwa`'s precache warning. Each kept
// its own copy and they had diverged — render's stopped at `kb`, so one 5 MiB route read `5120kb`
// in the budget error and `5mb` in the warning about the same bytes.

/** 1024-based, because every producer here counts bundle bytes, which tooling reports in KiB. */
const STEP = 1024;

/**
 * Ascending, so the index into it IS the power of `STEP`. `gb` is the last rung on purpose: a
 * precache or a route bundle past a terabyte is a bug in the caller, not a unit this should grow.
 */
const UNITS = ['b', 'kb', 'mb', 'gb'] as const;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * A size a message can state — `1023b`, `4.5kb`, `5mb`, `1.2gb`.
 *
 * Not `@ultimat3/ui`'s `formatBytes(bytes, locale)`, which is `Intl`-formatted, DECIMAL (kB = 1000
 * B, because that is what `Intl`'s unit means) and for a human reading a file picker. This one is
 * for an error's `cause:`, where the number has to line up with a bundler's own KiB figures and
 * must not change with the reader's locale.
 *
 * A negative or non-finite input answers `0b` rather than `-5b` or `NaNb`: axiom 4 says an error is
 * an instruction, and `NaNb` instructs nobody. A size is never negative, so the input was already
 * wrong by the time it arrived.
 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0${UNITS[0]}`;
  let value = bytes;
  let index = 0;
  while (index < UNITS.length - 1 && value >= STEP) {
    value /= STEP;
    index += 1;
  }
  // One more rung when ROUNDING crosses the boundary the raw value did not: 1048575 is under a
  // mebibyte, but one decimal place renders it `1024kb` — a number that disagrees with its own
  // unit, the same class of bug as render's missing `mb` branch.
  if (index < UNITS.length - 1 && round1(value) >= STEP) {
    value /= STEP;
    index += 1;
  }
  return `${round1(value)}${UNITS[index] ?? 'b'}`;
};
