import { describe, expect, test } from 'bun:test';
import {
  CHART_SERIES_SLOTS,
  chartNumberFormat,
  chartPercentFormat,
  chartTable,
  cssPercent,
  finiteOrNull,
  hitEdge,
  markerPath,
  pointLabel,
  seriesStyle,
} from './chart-frame-view';

describe('seriesStyle', () => {
  test('the first eight series take the eight colour slots, in order', () => {
    const slots = Array.from({ length: CHART_SERIES_SLOTS }, (_, i) => seriesStyle(i).slot);
    expect(slots).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('no two of the first eight share a dash AND a marker — colour is never the only cue', () => {
    const cues = Array.from({ length: 8 }, (_, i) => {
      const style = seriesStyle(i);
      return `${style.dash ?? 'solid'}|${style.marker}`;
    });
    expect(new Set(cues).size).toBe(8);
    // Marker shapes alone tell all eight apart, for the charts that draw no line (donut, legend).
    expect(new Set(Array.from({ length: 8 }, (_, i) => seriesStyle(i).marker)).size).toBe(8);
  });

  test('a ninth series reuses a colour slot but not the whole look of the first', () => {
    const first = seriesStyle(0);
    const ninth = seriesStyle(8);
    expect(ninth.slot).toBe(first.slot);
    expect(ninth.dash).not.toBe(first.dash);
  });

  test('the first series is a solid line', () => {
    expect(seriesStyle(0).dash).toBeUndefined();
  });

  test('a negative or fractional index is read as its slot, never as slot 0 or NaN', () => {
    expect(seriesStyle(-1).slot).toBe(1);
    expect(seriesStyle(2.7).slot).toBe(3);
  });
});

describe('markerPath', () => {
  test('every shape is one closed path centred on the point', () => {
    for (let i = 0; i < 8; i += 1) {
      const d = markerPath(seriesStyle(i).marker, 50, 20, 4);
      expect(d).toMatch(/^M/);
      expect(d).toMatch(/Z$/);
      const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      const xs = numbers.filter((_, n) => n % 2 === 0);
      const ys = numbers.filter((_, n) => n % 2 === 1);
      // Inside the marker's box — a shape that strayed would sit on the neighbouring point.
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(45.9);
      expect(Math.max(...xs)).toBeLessThanOrEqual(54.1);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(15.9);
      expect(Math.max(...ys)).toBeLessThanOrEqual(24.1);
    }
  });

  test('two shapes draw two different paths', () => {
    expect(markerPath('square', 0, 0, 4)).not.toBe(markerPath('diamond', 0, 0, 4));
  });
});

describe('chartTable', () => {
  const format = (value: number): string => `#${value}`;

  test('one row per key, one column per series, every cell the formatted value', () => {
    const table = chartTable({
      caption: 'Signups',
      keyLabel: 'Day',
      keys: ['mon', 'tue'],
      series: [
        { label: 'web', values: [1, 2] },
        { label: 'app', values: [3, null] },
      ],
      format,
    });
    expect(table.caption).toBe('Signups');
    expect(table.head).toEqual(['Day', 'web', 'app']);
    expect(table.rows).toEqual([
      { key: 'mon', cells: ['#1', '#3'] },
      // A gap is an empty cell — never a 0 the chart did not draw.
      { key: 'tue', cells: ['#2', ''] },
    ]);
  });

  test('a series shorter than the keys reads as gaps, not as a shifted column', () => {
    const table = chartTable({
      caption: 'x',
      keyLabel: undefined,
      keys: ['a', 'b', 'c'],
      series: [{ label: 's', values: [5] }],
      format,
    });
    expect(table.head).toEqual(['', 's']);
    expect(table.rows.map((row) => row.cells)).toEqual([['#5'], [''], ['']]);
  });
});

describe('chartNumberFormat', () => {
  test('formats in the locale it is GIVEN — there is no default', () => {
    expect(chartNumberFormat('en')(12345.678)).toBe('12,345.68');
    expect(chartNumberFormat('de')(12345.678)).toBe('12.345,68');
    expect(chartNumberFormat('en', 0)(2.5)).toBe('3');
  });
});

describe('chartPercentFormat', () => {
  test('a share as a percentage in the locale given, one decimal at most', () => {
    expect(chartPercentFormat('en')(0.256)).toBe('25.6%');
    // German puts a no-break space before the sign — the locale's rule, not ours.
    expect(chartPercentFormat('de')(0.5)).toBe('50\u00a0%');
    expect(chartPercentFormat('en')(1)).toBe('100%');
  });
});

describe('finiteOrNull', () => {
  test('a missing, NaN or infinite value is a gap', () => {
    expect([1, undefined, null, Number.NaN, Number.POSITIVE_INFINITY].map(finiteOrNull)).toEqual([
      1,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('pointLabel', () => {
  test('names the key, the series and the value, in that order', () => {
    expect(pointLabel('2026-09-17', 'Signups', '12')).toBe('2026-09-17, Signups: 12');
    expect(pointLabel('Mobile', undefined, '40%')).toBe('Mobile: 40%');
  });
});

describe('cssPercent', () => {
  test('a position as a CSS percentage, two decimals, clamped to the box', () => {
    expect(cssPercent(150, 600)).toBe('25%');
    expect(cssPercent(1, 3)).toBe('33.33%');
    expect(cssPercent(-5, 100)).toBe('0%');
    expect(cssPercent(500, 100)).toBe('100%');
    expect(cssPercent(5, 0)).toBe('0%');
  });
});

describe('hitEdge', () => {
  test('a point in the outer fifth opens its readout inward; the rest centre it', () => {
    expect(hitEdge(10, 600)).toBe('start');
    expect(hitEdge(300, 600)).toBe('middle');
    expect(hitEdge(590, 600)).toBe('end');
  });
});
