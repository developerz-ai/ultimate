import { describe, expect, test } from 'bun:test';
import type { LcovRecord } from './coverage-lcov';
import type { ChunkMap } from './coverage-remap';
import { chunkLines, firstSegments, withChunkLines } from './coverage-remap';

/** Bun 1.4.4's map of a two-function island, whitespace kept (`verify-coverage-run-island.test.ts`). */
const MAPPINGS =
  ';AAAO,SAAS,CAAK,CAAC,GAAmB;AAAA,EACvC,OAAO,SAAS,OAAO,CAAC;AAAA;AAGnB,SAAS,CAAK,CAAC,GAA6B,GAA4B;AAAA,EAC7E,IAAM,IAAO,EAAM,EAAM,CAAC;AAAA,EAC1B,EAAG,cAAc;AAAA;';

const SOURCE = [
  'export function label(n: number): string {',
  "  return 'count ' + String(n);",
  '}',
  '',
  'export function mount(el: { textContent: string }, props: { n: number }): void {',
  '  const text = label(props.n);',
  '  el.textContent = text;',
  '}',
  '',
].join('\n');

const MAP: ChunkMap = {
  module: 'abc.mjs',
  sources: ['/app/apps/web/app/counter.island.ts'],
  sourcesContent: [SOURCE],
  mappings: MAPPINGS,
};

const record = (lines: Record<number, number>): LcovRecord => ({
  file: '../../tmp/x/abc.mjs',
  linesFound: 0,
  linesHit: 0,
  funcsFound: 2,
  funcsHit: 1,
  lines: new Map(Object.entries(lines).map(([line, hits]) => [Number(line), hits])),
});

const KEY = 'apps/web/app/counter.island.ts';
const keyOf = (absolute: string): string | undefined =>
  absolute === MAP.sources[0] ? KEY : undefined;

describe('firstSegments', () => {
  test('each generated line names the original line its statement starts on', () => {
    const lines = firstSegments(MAPPINGS).map((at) => at?.[1]);
    // Generated line 2 is `function o(t) {` (original 0), 3 its `return` (original 1), and the
    // indented lines 6-7 are `mount`'s body (originals 5, 6) — not the line above them, which is
    // where the indent's own carried segment points.
    expect(lines.slice(0, 7)).toEqual([undefined, 0, 1, undefined, 4, 5, 6]);
  });

  test('a line of no segments and a malformed segment name nothing', () => {
    expect(firstSegments(';;!!!;AAAA')).toEqual([undefined, undefined, undefined, [0, 0]]);
  });
});

describe('chunkLines', () => {
  test('a chunk line that ran is its source line hit, one that did not a miss', () => {
    const lines = chunkLines(record({ 2: 1, 3: 1, 5: 1, 6: 0, 7: 0 }), MAP, keyOf, () => SOURCE);
    const facts = lines.get(KEY);
    expect([...(facts?.hit ?? [])].sort()).toEqual([1, 2, 5]);
    expect([...(facts?.miss ?? [])].sort()).toEqual([6, 7]);
  });

  test('a line whose built text is not the text on disk is credited to nothing', () => {
    // What a transform that moved the lines (Babel without `retainLines`) hands over: the map
    // names line 6 of text the file does not hold at line 6.
    const moved = SOURCE.replace(
      '  const text = label(props.n);',
      '  const text = label(props.n); // edited',
    );
    const lines = chunkLines(record({ 6: 1, 7: 1 }), MAP, keyOf, () => moved);
    expect([...(lines.get(KEY)?.hit ?? [])]).toEqual([7]);
  });

  test('a source outside the app is never keyed', () => {
    expect(
      chunkLines(
        record({ 2: 1 }),
        MAP,
        () => undefined,
        () => SOURCE,
      ).size,
    ).toBe(0);
  });
});

describe('withChunkLines', () => {
  const base = { hit: [1, 5], miss: [2, 6, 7], funcsFound: 2, funcsHit: 0 };

  test('loaded directly: misses the chunk ran turn hit, and the line set never grows', () => {
    const merged = withChunkLines(base, { hit: new Set([6, 7, 40]), miss: new Set() }, SOURCE);
    expect(merged).toEqual({ hit: [1, 5, 6, 7], miss: [2], funcsFound: 2, funcsHit: 0 });
  });

  test('loaded directly and the chunk ran nothing new: the record is unchanged', () => {
    expect(withChunkLines(base, { hit: new Set([1]), miss: new Set([2]) }, SOURCE)).toBe(base);
  });

  test('not loaded directly: every code line counts, and functions are left to a direct record', () => {
    const lines = { hit: new Set([2, 6]), miss: new Set([7]) };
    expect(withChunkLines(undefined, lines, SOURCE)).toEqual({
      hit: [2, 6],
      miss: [1, 3, 5, 7, 8],
      funcsFound: 0,
      funcsHit: 0,
    });
  });
});
