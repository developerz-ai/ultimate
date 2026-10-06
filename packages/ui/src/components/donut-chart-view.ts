// The arc maths of a DonutChart (and a Gauge's track): where each segment starts and ends, the
// annular-sector path that draws it, and where its marker sits. Angles are radians from twelve
// o'clock, clockwise — the way a reader goes round a clock face. Pure, so two renders agree.

import { svgNumber } from './chart-frame-view';

/** A 200 × 200 box; the ring is 32 units wide, which leaves room for a centre label inside. */
export const DONUT = { size: 200, centre: 100, outer: 96, inner: 64, marker: 6 } as const;

const TURN = Math.PI * 2;
/** The gap between two neighbours, so a segment boundary reads without relying on colour. */
const GAP = 0.03;
/** The least sweep a non-zero segment is drawn with: a 0.1% share is still a visible sliver. */
const MIN_SWEEP = 0.012;

export interface CirclePoint {
  readonly x: number;
  readonly y: number;
}

export function pointOnCircle(cx: number, cy: number, r: number, angle: number): CirclePoint {
  return { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
}

const at = (p: CirclePoint): string => `${svgNumber(p.x)},${svgNumber(p.y)}`;

function sector(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const o0 = pointOnCircle(cx, cy, outer, a0);
  const o1 = pointOnCircle(cx, cy, outer, a1);
  const i1 = pointOnCircle(cx, cy, inner, a1);
  const i0 = pointOnCircle(cx, cy, inner, a0);
  return (
    `M${at(o0)} A${outer},${outer} 0 ${large} 1 ${at(o1)} ` +
    `L${at(i1)} A${inner},${inner} 0 ${large} 0 ${at(i0)} Z`
  );
}

/**
 * The ring between radii `inner` and `outer` from angle `a0` to `a1`. A sweep of a whole turn is
 * drawn as two halves: an SVG arc from a point back to itself has no direction and draws nothing.
 */
export function annularSector(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  a0: number,
  a1: number,
): string {
  if (!(a1 > a0)) return '';
  if (a1 - a0 >= TURN - 1e-9) {
    const half = a0 + Math.PI;
    return `${sector(cx, cy, outer, inner, a0, half)} ${sector(cx, cy, outer, inner, half, a0 + TURN)}`;
  }
  return sector(cx, cy, outer, inner, a0, a1);
}

export interface DonutArc {
  /** This value's part of the positive total; 0 for a value that is not drawn. */
  readonly share: number;
  /** The segment's slot on the ring, before the gap is taken off. */
  readonly start: number;
  readonly end: number;
  /** What is actually drawn: the slot less half a gap at each end. */
  readonly drawnStart: number;
  readonly drawnEnd: number;
  readonly path: string;
  /** Mid-ring, mid-segment: where a focusable segment's hit sits. `null` for a share of 0. */
  readonly anchor: CirclePoint | null;
  /** The anchor again, or `null` where the segment is too narrow to hold a marker. */
  readonly marker: CirclePoint | null;
}

const positive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** One arc per value, in order from twelve o'clock; a non-positive value is listed, not drawn. */
export function donutArcs(values: readonly number[]): readonly DonutArc[] {
  const { centre, outer, inner, marker } = DONUT;
  const total = values.reduce((sum, value) => sum + positive(value), 0);
  const drawn = values.filter((value) => positive(value) > 0).length;
  const gap = drawn > 1 ? GAP : 0;
  const mid = (outer + inner) / 2;
  let cursor = 0;
  return values.map((value): DonutArc => {
    const share = total > 0 ? positive(value) / total : 0;
    const start = cursor;
    const end = cursor + share * TURN;
    cursor = end;
    if (share === 0) {
      return {
        share,
        start,
        end,
        drawnStart: start,
        drawnEnd: start,
        path: '',
        anchor: null,
        marker: null,
      };
    }
    const centreAngle = (start + end) / 2;
    const sweep = Math.max(MIN_SWEEP, end - start - gap);
    const drawnStart = gap === 0 ? start : centreAngle - sweep / 2;
    const drawnEnd = gap === 0 ? end : centreAngle + sweep / 2;
    // A marker needs about three of its own widths of arc, or it spills onto the neighbours.
    const fits = sweep * mid >= marker * 3;
    const anchor = pointOnCircle(centre, centre, mid, centreAngle);
    return {
      share,
      start,
      end,
      drawnStart,
      drawnEnd,
      path: annularSector(centre, centre, outer, inner, drawnStart, drawnEnd),
      anchor,
      marker: fits ? anchor : null,
    };
  });
}
