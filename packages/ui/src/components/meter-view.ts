// The arithmetic of a Meter, apart from its markup: a share of a maximum, clamped, and the width
// attribute that share becomes. Pure so a server render and a hydrated one cannot disagree.

/** `value / max` clamped to 0..1; a non-positive or non-finite `max` is an empty meter. */
export function meterShare(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** The fill's `width` on a 100-unit viewBox, to one decimal — stable across renders. */
export function meterWidth(share: number): string {
  return (share * 100).toFixed(1);
}

/**
 * The `aria-valuenow` / `aria-valuemax` pair, from the SAME rule as the fill: a meter that draws
 * full must not speak "7 of 4". With no usable maximum the bar is empty, and so is the range it
 * speaks — 0 of 1, because `aria-valuemax` must stay above `aria-valuemin`.
 */
export function meterAria(
  value: number,
  max: number,
): { readonly now: number; readonly max: number } {
  if (!Number.isFinite(max) || max <= 0) return { now: 0, max: 1 };
  return { now: Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0, max };
}
