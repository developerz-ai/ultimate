// The dial of a Gauge, apart from its markup: a 270° ring open at the bottom, and the share of it
// a value fills. `Gauge` takes that share from `meterShare` — one rule for "value of max", so a
// Gauge and a Meter beside it can never disagree about what 7 of 4 draws.

import { svgNumber } from './chart-frame-view';
import { annularSector } from './donut-chart-view';
import type { Tone } from './variants';

/**
 * 200 wide, cropped to 172 tall: the dial's open quarter is at the bottom, and the box ends just
 * under the ring's lowest point (`gauge-view.test.ts` holds that) instead of spending the strip.
 */
export const GAUGE = {
  width: 200,
  height: 172,
  centre: 100,
  outer: 92,
  inner: 74,
  /** Seven-thirty: -135° from twelve o'clock. */
  from: -Math.PI * 0.75,
  sweep: Math.PI * 1.5,
} as const;

const clampShare = (share: number): number =>
  Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;

/** The angle where a fill of `share` stops. */
export function gaugeFillEnd(share: number): number {
  return GAUGE.from + clampShare(share) * GAUGE.sweep;
}

export interface GaugeArcs {
  readonly track: string;
  /** `''` at a share of 0 — an empty dial is the track alone, not a zero-width sliver. */
  readonly fill: string;
}

export function gaugeArcs(share: number): GaugeArcs {
  const { centre, outer, inner, from } = GAUGE;
  const end = gaugeFillEnd(share);
  return {
    track: annularSector(centre, centre, outer, inner, from, gaugeFillEnd(1)),
    fill: annularSector(centre, centre, outer, inner, from, end),
  };
}

/** A target's tick: a radial stroke across the ring at `share`, a little proud of both edges. */
export function gaugeTick(share: number): string {
  const { centre, outer, inner } = GAUGE;
  const angle = gaugeFillEnd(share);
  const at = (r: number): string =>
    `${svgNumber(centre + Math.sin(angle) * r)},${svgNumber(centre - Math.cos(angle) * r)}`;
  return `M${at(inner - 4)} L${at(outer + 4)}`;
}

export interface GaugeThreshold {
  /** In the value's own unit: the tone applies from this value up. Ascending. */
  readonly at: number;
  readonly tone: Tone;
}

/** The tone of the highest threshold `value` has reached, or `fallback` below them all. */
export function thresholdTone(
  value: number | null,
  thresholds: readonly GaugeThreshold[] | undefined,
  fallback: Tone,
): Tone {
  if (value === null || !Number.isFinite(value)) return fallback;
  let tone = fallback;
  for (const threshold of thresholds ?? []) if (value >= threshold.at) tone = threshold.tone;
  return tone;
}
