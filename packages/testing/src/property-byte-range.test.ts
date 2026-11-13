// Property: a `Range: bytes=…` header, well-formed or hostile, is a window inside the body, the
// whole body, or a 416 — never a window past the end or a negative length.

import { describe, expect, test } from 'bun:test';
import { parseByteRange, RANGE_UNSATISFIABLE } from '@ultimat3/http';
import { property } from './property';
import { gen } from './property-gen';

const bound = gen.union([gen.constant(''), gen.map(gen.int(0, 2_000), String)]);
const junk = gen.string({ maxLength: 6, chars: gen.oneOf(['-', ',', ' ', '=', 'x', '0', '9']) });
const header = gen.union([
  gen.map(gen.tuple(bound, bound), ([from, to]) => `bytes=${from}-${to}`),
  gen.map(gen.tuple(junk, bound, junk), ([a, n, b]) => `${a}bytes=${n}${b}`),
]);

describe('byte range properties', () => {
  test('a range is always a non-empty window inside the body', () => {
    property(
      gen.tuple(header, gen.int(0, 1_500)),
      ([value, size]) => {
        const range = parseByteRange(value, size);
        if (range === undefined || range === RANGE_UNSATISFIABLE) return;
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.start).toBeLessThanOrEqual(range.end);
        expect(range.end).toBeLessThan(size);
      },
      { runs: 1_000 },
    );
  });

  test('a first-last range inside the body is exactly what was asked', () => {
    property(
      gen.tuple(gen.int(1, 1_500), gen.int(0, 1_500), gen.int(0, 1_500)),
      ([size, a, b]) => {
        const [start, end] = a <= b ? [a, b] : [b, a];
        const range = parseByteRange(`bytes=${start}-${end}`, size);
        if (start >= size) expect(range).toBe(RANGE_UNSATISFIABLE);
        else expect(range).toEqual({ start, end: Math.min(end, size - 1) });
      },
      { runs: 1_000 },
    );
  });

  test('a suffix range is the last n bytes, or 416 when it names none', () => {
    property(
      gen.tuple(gen.int(0, 1_500), gen.int(0, 2_000)),
      ([size, n]) => {
        const range = parseByteRange(`bytes=-${n}`, size);
        if (size === 0 || n === 0) expect(range).toBe(RANGE_UNSATISFIABLE);
        else expect(range).toEqual({ start: Math.max(size - n, 0), end: size - 1 });
      },
      { runs: 1_000 },
    );
  });
});
