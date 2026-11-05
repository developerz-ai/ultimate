import { describe, expect, test } from 'bun:test';
import { SPARKLINE, sparklinePath, sparkPoints } from './sparkline-view';

const points = (...values: number[]) => values.map((value, i) => ({ key: `d${i}`, value }));

describe('sparkPoints', () => {
  test('spans the padded box, with the busiest point at the top and a zero at the bottom', () => {
    const [a, b, c] = sparkPoints(points(0, 10, 5));
    expect(a?.x).toBe(SPARKLINE.pad);
    expect(c?.x).toBe(SPARKLINE.width - SPARKLINE.pad);
    expect(a?.y).toBe(SPARKLINE.height - SPARKLINE.pad);
    expect(b?.y).toBe(SPARKLINE.pad);
  });

  test('a single point sits at the start rather than dividing by zero', () => {
    expect(sparkPoints(points(3))[0]?.x).toBe(SPARKLINE.pad);
  });
});

describe('sparklinePath', () => {
  test('is one M then Ls, one decimal each, and empty for no points', () => {
    expect(sparklinePath(points(0, 10))).toBe('M4.0,68.0 L596.0,4.0');
    expect(sparklinePath([])).toBe('');
  });
});

/**
 * An unknown value is a GAP, as `LineChart` holds: `[5, null, 5]` used to draw a dive to the
 * baseline in the middle — a zero nobody measured.
 */
describe('sparklinePath with gaps', () => {
  const gappy = [
    { key: 'd0', value: 5 },
    { key: 'd1', value: null },
    { key: 'd2', value: 5 },
    { key: 'd3', value: 2 },
  ];

  test('null splits the line into runs, one M each, with no point at the baseline', () => {
    const d = sparklinePath(gappy);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).not.toContain(`,${(SPARKLINE.height - SPARKLINE.pad).toFixed(1)}`);
    expect(d).toBe('M4.0,4.0 M398.7,4.0 L596.0,42.4');
  });

  test('a null point has no position, and every other point keeps its index', () => {
    const placed = sparkPoints(gappy);
    expect(placed[1]).toBeNull();
    expect(placed[2]?.x).toBeCloseTo(398.667, 2);
  });

  test('all unknown is no line at all', () => {
    expect(sparklinePath([{ key: 'd0', value: null }])).toBe('');
  });
});
