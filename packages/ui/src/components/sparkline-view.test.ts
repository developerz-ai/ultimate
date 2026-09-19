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
