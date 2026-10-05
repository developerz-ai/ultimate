import { describe, expect, test } from 'bun:test';
import {
  decodeCoverage,
  decodeLines,
  encodeCoverage,
  encodeLines,
  fileCoverageOf,
  mergeCoverage,
  mergeFileCoverage,
  parseLcov,
  percent,
} from './coverage-lcov';

const LCOV = [
  'TN:',
  'SF:apps/web/app/a.ts',
  'FNF:2',
  'FNH:1',
  'DA:1,3',
  'DA:2,0',
  'DA:5,1',
  'LF:3',
  'LH:2',
  'end_of_record',
  'SF:../../packages/core/src/x.ts',
  'FNF:9',
  'FNH:0',
  'DA:1,0',
  'LF:1',
  'LH:0',
  'end_of_record',
  '',
].join('\n');

describe('parseLcov', () => {
  test('a Windows SF path is keyed with / like the source walk', () => {
    const records = parseLcov('TN:\nSF:apps\\web\\app\\a.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n');
    expect(records.map((record) => record.file)).toEqual(['apps/web/app/a.ts']);
  });

  test('one record per SF, with its counts and every DA line', () => {
    const records = parseLcov(LCOV);
    expect(records.map((record) => record.file)).toEqual([
      'apps/web/app/a.ts',
      '../../packages/core/src/x.ts',
    ]);
    const [first] = records;
    expect(first?.linesFound).toBe(3);
    expect(first?.linesHit).toBe(2);
    expect(first?.funcsFound).toBe(2);
    expect(first?.funcsHit).toBe(1);
    expect([...(first?.lines ?? [])]).toEqual([
      [1, 3],
      [2, 0],
      [5, 1],
    ]);
  });

  test('a record that never closes is not a record, and a malformed DA is not a line', () => {
    expect(parseLcov('SF:a.ts\nDA:1,1\n')).toEqual([]);
    const [record] = parseLcov('SF:a.ts\nDA:x,1\nDA:,\nDA:2,1\nend_of_record\n');
    expect([...(record?.lines.keys() ?? [])]).toEqual([2]);
  });

  test('fileCoverageOf splits the lines by whether they ran', () => {
    const [record] = parseLcov(LCOV);
    if (record === undefined) expect.unreachable('the fixture holds a record');
    expect(fileCoverageOf(record)).toEqual({ hit: [1, 5], miss: [2], funcsFound: 2, funcsHit: 1 });
  });
});

describe('mergeFileCoverage', () => {
  // Process A called the function (Bun lists its executable lines: 1, 4). Process B only loaded
  // the file (Bun lists the whole range 1-4 as unrun — 2 and 3 are comments).
  const called = { hit: [1, 4], miss: [], funcsFound: 1, funcsHit: 1 };
  const loaded = { hit: [], miss: [1, 2, 3, 4], funcsFound: 1, funcsHit: 0 };

  test('a line one process ran is covered, and a line only SOME list as unrun is not a line', () => {
    expect(mergeFileCoverage([called, loaded])).toEqual({
      hit: [1, 4],
      miss: [],
      funcsFound: 1,
      funcsHit: 1,
    });
    // Whichever process is first: the fold is not an accident of order.
    expect(mergeFileCoverage([loaded, called])).toEqual(mergeFileCoverage([called, loaded]));
  });

  test('a line EVERY process lists as unrun is uncovered', () => {
    const merged = mergeFileCoverage([loaded, { ...loaded, miss: [1, 2, 3, 4, 9] }]);
    expect(merged.miss).toEqual([1, 2, 3, 4]);
    expect(merged.hit).toEqual([]);
  });

  test('functions take the best one process reached — counts carry no identity to union', () => {
    const merged = mergeFileCoverage([
      { hit: [], miss: [], funcsFound: 4, funcsHit: 1 },
      { hit: [], miss: [], funcsFound: 6, funcsHit: 3 },
    ]);
    expect(merged.funcsFound).toBe(6);
    expect(merged.funcsHit).toBe(3);
  });

  test('one part is itself', () => {
    expect(mergeFileCoverage([called])).toBe(called);
  });
});

describe('mergeCoverage', () => {
  test('file by file, sorted, a file one map alone holds kept as it is', () => {
    const merged = mergeCoverage([
      { 'b.ts': { hit: [1], miss: [2], funcsFound: 1, funcsHit: 1 } },
      {
        'b.ts': { hit: [2], miss: [1], funcsFound: 1, funcsHit: 1 },
        'a.ts': { hit: [], miss: [7], funcsFound: 2, funcsHit: 0 },
      },
    ]);
    expect(Object.keys(merged)).toEqual(['a.ts', 'b.ts']);
    expect(merged['b.ts']).toEqual({ hit: [1, 2], miss: [], funcsFound: 1, funcsHit: 1 });
    expect(merged['a.ts']?.miss).toEqual([7]);
  });

  test('folding shards of already-folded processes is the fold of all of them', () => {
    const p1 = { 'a.ts': { hit: [1], miss: [2, 3], funcsFound: 2, funcsHit: 1 } };
    const p2 = { 'a.ts': { hit: [], miss: [1, 2], funcsFound: 2, funcsHit: 0 } };
    const p3 = { 'a.ts': { hit: [5], miss: [2, 3], funcsFound: 2, funcsHit: 1 } };
    expect(mergeCoverage([mergeCoverage([p1, p2]), p3])).toEqual(mergeCoverage([p1, p2, p3]));
  });
});

describe('the wire form a shard hands to x verify merge', () => {
  test('lines travel as runs', () => {
    expect(encodeLines([3, 1, 2, 7, 9, 10])).toBe('1-3,7,9-10');
    expect(encodeLines([])).toBe('');
    expect(decodeLines('1-3,7,9-10')).toEqual([1, 2, 3, 7, 9, 10]);
    expect(decodeLines('')).toEqual([]);
    expect(decodeLines('x,4,5-')).toEqual([4]);
  });

  test('a map round-trips, and anything else is refused rather than read as empty', () => {
    const map = { 'a.ts': { hit: [1, 2, 3], miss: [8], funcsFound: 2, funcsHit: 1 } };
    const wire = encodeCoverage(map);
    expect(wire['a.ts']).toEqual({ h: '1-3', m: '8', f: [2, 1] });
    expect(decodeCoverage(JSON.parse(JSON.stringify(wire)))).toEqual(map);
    expect(decodeCoverage(undefined)).toBeUndefined();
    expect(decodeCoverage([])).toBeUndefined();
    expect(decodeCoverage({ 'a.ts': null })).toBeUndefined();
    expect(decodeCoverage({ 'a.ts': { h: '1', m: 2, f: [1, 1] } })).toBeUndefined();
    expect(decodeCoverage({ 'a.ts': { h: '1', m: '', f: ['1', 1] } })).toBeUndefined();
  });
});

test('percent: two decimals, and nothing found is zero rather than a pass', () => {
  expect(percent(2, 3)).toBe(66.67);
  expect(percent(0, 0)).toBe(0);
  expect(percent(5, 5)).toBe(100);
});
