import { describe, expect, test } from 'bun:test';
import { annularSector, DONUT, donutArcs, pointOnCircle } from './donut-chart-view';

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

describe('pointOnCircle', () => {
  test('angle 0 is twelve o’clock and angles run clockwise', () => {
    const top = pointOnCircle(100, 100, 50, 0);
    expect([top.x, top.y]).toEqual([100, 50]);
    const right = pointOnCircle(100, 100, 50, Math.PI / 2);
    expect(close(right.x, 150) && close(right.y, 100)).toBe(true);
    const bottom = pointOnCircle(100, 100, 50, Math.PI);
    expect(close(bottom.x, 100) && close(bottom.y, 150)).toBe(true);
  });
});

describe('annularSector', () => {
  test('a quarter is one outer arc, one inner arc, closed — and never the large-arc flag', () => {
    const d = annularSector(100, 100, 90, 60, 0, Math.PI / 2);
    expect(d).toStartWith('M100,10 A90,90 0 0 1 190,100 L160,100 A60,60 0 0 0 100,40 Z');
  });

  test('more than half a turn sets the large-arc flag on both arcs', () => {
    const d = annularSector(100, 100, 90, 60, 0, Math.PI * 1.5);
    expect(d.match(/ 0 1 1 /g)).toHaveLength(1);
    expect(d.match(/ 0 1 0 /g)).toHaveLength(1);
  });

  test('a whole turn is two halves — one arc from a point to itself draws nothing', () => {
    const d = annularSector(100, 100, 90, 60, 0, Math.PI * 2);
    expect(d.match(/Z/g)).toHaveLength(2);
    expect(d).not.toContain('NaN');
  });

  test('an empty or reversed sweep draws nothing', () => {
    expect(annularSector(100, 100, 90, 60, 1, 1)).toBe('');
    expect(annularSector(100, 100, 90, 60, 2, 1)).toBe('');
  });
});

describe('donutArcs', () => {
  test('shares follow the values and the sweeps add up to the whole turn, gaps included', () => {
    const segments = donutArcs([1, 1, 2]);
    expect(segments.map((s) => s.share)).toEqual([0.25, 0.25, 0.5]);
    const first = segments[0];
    const last = segments[2];
    expect(first?.start).toBeCloseTo(0);
    expect(last?.end).toBeCloseTo(Math.PI * 2);
    // Each drawn sweep is its share minus the gap, so two neighbours never touch.
    for (const s of segments) expect(s.drawnEnd - s.drawnStart).toBeLessThan(s.end - s.start);
  });

  test('a lone segment is a full ring with no gap', () => {
    const [only] = donutArcs([5]);
    expect(only?.share).toBe(1);
    expect((only?.drawnEnd ?? 0) - (only?.drawnStart ?? 0)).toBeCloseTo(Math.PI * 2);
    expect(only?.path.match(/Z/g)).toHaveLength(2);
  });

  test('a zero, negative or non-finite value is listed with share 0 and draws no path', () => {
    const segments = donutArcs([3, 0, -2, Number.NaN, 1]);
    expect(segments.map((s) => s.share)).toEqual([0.75, 0, 0, 0, 0.25]);
    expect(segments.map((s) => s.path === '')).toEqual([false, true, true, true, false]);
  });

  test('nothing to total draws nothing, and divides by nothing', () => {
    const segments = donutArcs([0, 0]);
    expect(segments.every((s) => s.share === 0 && s.path === '')).toBe(true);
  });

  test('the marker sits mid-ring at the middle of the segment, and only where it fits', () => {
    const [big, small] = donutArcs([99, 1]);
    const mid = (DONUT.outer + DONUT.inner) / 2;
    const marker = big?.marker;
    expect(marker).not.toBeNull();
    const distance = Math.hypot((marker?.x ?? 0) - DONUT.centre, (marker?.y ?? 0) - DONUT.centre);
    expect(distance).toBeCloseTo(mid);
    expect(small?.marker).toBeNull();
    // Too narrow for a marker is still somewhere a keyboard can land.
    expect(small?.anchor).not.toBeNull();
  });
});
