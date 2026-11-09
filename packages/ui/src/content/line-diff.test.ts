// The differ: minimal scripts, numbered rows, word marks in a changed pair, a fold past the cap,
// and hostile input bounded by the edit cap instead of searched quadratically.

import { describe, expect, test } from 'bun:test';
import { type DiffRow, diffOps, foldRows, lineDiff, wordMarks } from './line-diff';

const signs = (rows: readonly DiffRow[]): string =>
  rows
    .map((row) =>
      row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : row.kind === 'context' ? ' ' : '?',
    )
    .join('');

describe('diffOps', () => {
  test('a minimal script: one changed line in the middle', () => {
    expect(diffOps(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual(['equal', 'del', 'add', 'equal']);
  });

  test('applying the script turns a into b, on many random pairs', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed;
    };
    for (let round = 0; round < 200; round += 1) {
      const a = Array.from({ length: next() % 12 }, () => String(next() % 4));
      const b = Array.from({ length: next() % 12 }, () => String(next() % 4));
      const ops = diffOps(a, b);
      const rebuilt: string[] = [];
      let i = 0;
      let j = 0;
      for (const op of ops) {
        if (op === 'equal') {
          expect(a[i]).toBe(b[j] as string);
          rebuilt.push(a[i] ?? '');
          i += 1;
          j += 1;
        } else if (op === 'del') i += 1;
        else {
          rebuilt.push(b[j] ?? '');
          j += 1;
        }
      }
      expect(rebuilt).toEqual(b);
      expect(i).toBe(a.length);
    }
  });

  test('past the edit cap the middle is a plain replace, fast', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 20_000 }, (_, i) => `b${i}`);
    const began = performance.now();
    const ops = diffOps(a, b, 200);
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(ops.filter((op) => op === 'del')).toHaveLength(20_000);
  });
});

describe('lineDiff', () => {
  test('numbers each side and marks the changed word', () => {
    const rows = lineDiff('one\nthe old word\nthree', 'one\nthe new word\nthree');
    expect(signs(rows)).toBe(' -+ ');
    const del = rows[1];
    const add = rows[2];
    expect(del).toMatchObject({ kind: 'del', old: 2 });
    expect(add).toMatchObject({ kind: 'add', new: 2 });
    expect(del && 'marks' in del ? del.marks : null).toEqual([[4, 7]]);
    expect(add && 'marks' in add ? add.marks : null).toEqual([[4, 7]]);
  });

  test('an empty side is all additions', () => {
    expect(signs(lineDiff('', 'a\nb'))).toBe('++');
  });

  test('wordMarks of identical text marks nothing', () => {
    expect(wordMarks('same text', 'same text')).toEqual([[], []]);
  });
});

test('foldRows keeps maxLines and says how many it left out', () => {
  const rows = lineDiff('', Array.from({ length: 10 }, (_, i) => String(i)).join('\n'));
  const folded = foldRows(rows, 4);
  expect(folded).toHaveLength(5);
  expect(folded.at(-1)).toEqual({ kind: 'fold', count: 6 });
  expect(foldRows(rows, 50)).toBe(rows);
});
