// The solver's skip list (`takenStrings`) is a shortcut, never a second answer: every problem solves
// to the same row, or the same refusal, with it as without it — the pass's seed stays the seed it
// was. Random problems, a seeded draw, and the try cap the shortcut must not see past.

import { describe, expect, test } from 'bun:test';
import { seededRandom } from './determinism';
import type { RowCheck, RowProblem } from './seed-graph-row';
import { solveRow, uniqueKey } from './seed-graph-row';
import { testName } from './test-types';

const PROPERTIES = ['a', 'b', 'c'] as const;

/** One random problem: string candidates drawn from a small pool, so values collide. */
function drawProblem(next: () => number): RowProblem {
  const pick = (n: number) => Math.floor(next() * n);
  const columns = PROPERTIES.map(
    (property) => [property, Array.from({ length: 1 + pick(6) }, () => `v${pick(8)}`)] as const,
  );
  const banned = `v${pick(8)}`;
  const checks: RowCheck[] =
    next() < 0.5
      ? [{ name: 'not_banned', properties: ['b'], holds: (row) => row['b'] !== banned }]
      : [];
  const uniques = [['a'], ['b'], ['a', 'c']];
  const taken = uniques.map(() => new Set<string>());
  const takenStrings = uniques.map((set) => (set.length === 1 ? new Set<string>() : undefined));
  // Earlier rows: each one's keys held, as the graph holds them.
  for (let r = pick(10); r > 0; r -= 1) {
    const row = Object.fromEntries(PROPERTIES.map((p) => [p, `v${pick(8)}`]));
    uniques.forEach((set, i) => {
      const key = uniqueKey(row, set);
      if (key === undefined) return;
      taken[i]?.add(key);
      if (set.length === 1) takenStrings[i]?.add(row[set[0] as string] as string);
    });
  }
  // A derive half the time, sometimes rewriting a column a one-property key holds: the skip list
  // must judge the row it built, never the candidate it started from.
  const rewrite = `v${pick(8)}`;
  const derive =
    next() < 0.5
      ? undefined
      : (row: Readonly<Record<string, unknown>>) => (row['c'] === rewrite ? { a: 'derived' } : {});
  return { columns, checks, uniques, taken, takenStrings, derive };
}

describe(testName('unit', 'solveRow · the skip list answers what the search answers'), () => {
  test('2,000 random problems: the same row or the same refusal, with it and without', () => {
    const next = seededRandom(1107);
    let skipped = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const problem = drawProblem(next);
      const { takenStrings: _, ...plain } = problem;
      const fast = solveRow(problem);
      expect(fast).toEqual(solveRow(plain));
      if (fast.ok) skipped += 1;
    }
    // Not vacuous: most draws solve, so the shortcut's own answer is what was compared.
    expect(skipped).toBeGreaterThan(500);
  });

  test('past the try cap the search gives up, and so does the shortcut', () => {
    // 5,000 candidates, the first 4,500 taken: the free one sits past the 4,096 tries `search`
    // makes, so it refuses — the shortcut must refuse too, not find what `search` never reaches.
    const values = Array.from({ length: 5_000 }, (_, i) => `p${i}`);
    const held = new Set(values.slice(0, 4_500));
    const problem: RowProblem = {
      columns: [['ref', values]],
      checks: [],
      uniques: [['ref']],
      taken: [new Set([...held].map((value) => JSON.stringify([value])))],
      takenStrings: [held],
    };
    const { takenStrings: _, ...plain } = problem;
    const fast = solveRow(problem);
    expect(fast.ok).toBe(false);
    expect(fast).toEqual(solveRow(plain));
  });

  test('under the cap the shortcut finds the first free candidate, as the search does', () => {
    const values = Array.from({ length: 3_000 }, (_, i) => `p${i}`);
    const held = new Set(values.slice(0, 2_000));
    const problem: RowProblem = {
      columns: [['ref', values]],
      checks: [],
      uniques: [['ref']],
      taken: [new Set([...held].map((value) => JSON.stringify([value])))],
      takenStrings: [held],
    };
    const { takenStrings: _, ...plain } = problem;
    expect(solveRow(problem)).toEqual({ ok: true, row: { ref: 'p2000' } });
    expect(solveRow(plain)).toEqual({ ok: true, row: { ref: 'p2000' } });
  });
});
