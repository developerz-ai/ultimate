import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import {
  costOf,
  junitDurations,
  loadTimings,
  longestFirst,
  recordTimings,
  SLOWEST_KEPT,
  slowestOf,
} from './test-timings';

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-test-timings-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the timings cache', () => {
  test('absent, broken or of another shape reads as empty — never a throw', async () => {
    const dir = await scratch();
    expect(await loadTimings(join(dir, 'none.json'))).toEqual({});
    await Bun.write(join(dir, 'broken.json'), '{ not json');
    expect(await loadTimings(join(dir, 'broken.json'))).toEqual({});
    await Bun.write(join(dir, 'list.json'), '[1, 2]');
    expect(await loadTimings(join(dir, 'list.json'))).toEqual({});
  });

  test("Bun's own shape and a bare map both read; a non-number entry is dropped", async () => {
    const dir = await scratch();
    await Bun.write(
      join(dir, 'bun.json'),
      JSON.stringify({
        version: 1,
        files: { 'a.test.ts': 120, 'b.test.ts': 'slow', 'c.test.ts': -1 },
      }),
    );
    expect(await loadTimings(join(dir, 'bun.json'))).toEqual({ 'a.test.ts': 120 });
    await Bun.write(join(dir, 'bare.json'), JSON.stringify({ 'a.test.ts': 7 }));
    expect(await loadTimings(join(dir, 'bare.json'))).toEqual({ 'a.test.ts': 7 });
  });

  test('a record merges over what is kept, in the shape `bun test --timings` reads back', async () => {
    const dir = await scratch();
    const path = join(dir, '.x', 'test-timings.json');
    await recordTimings(path, { 'a.test.ts': 100, 'b.test.ts': 200 });
    await recordTimings(path, { 'b.test.ts': 50 });
    await recordTimings(path, {});
    expect(await Bun.file(path).json()).toEqual({
      version: 1,
      files: { 'a.test.ts': 100, 'b.test.ts': 50 },
    });
  });

  test('a cache that cannot be written is skipped, never a failed run', async () => {
    const dir = await scratch();
    await Bun.write(join(dir, 'file'), 'x');
    // A path UNDER a file: mkdir refuses, and the record gives up quietly.
    await recordTimings(join(dir, 'file', 'test-timings.json'), { 'a.test.ts': 1 });
    expect(await loadTimings(join(dir, 'file', 'test-timings.json'))).toEqual({});
  });
});

describe('junitDurations', () => {
  test("each file's testsuite in ms; a nested describe and a broken report add nothing", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="bun test" tests="3" time="1.5">',
      '  <testsuite name="apps/a.test.ts" file="apps/a.test.ts" tests="2" time="1.2345">',
      '    <testsuite name="the describe" tests="1" time="0.5">',
      '    </testsuite>',
      '  </testsuite>',
      '  <testsuite name="apps/b &amp; c.test.ts" file="apps/b &amp; c.test.ts" tests="1" time="0.0004">',
      '  </testsuite>',
      '  <testsuite name="x" file="apps/nan.test.ts" time="soon">',
      '  </testsuite>',
      '</testsuites>',
    ].join('\n');
    expect(junitDurations(xml)).toEqual({ 'apps/a.test.ts': 1235, 'apps/b & c.test.ts': 0 });
    expect(junitDurations('')).toEqual({});
    expect(junitDurations('<testsuites><oops')).toEqual({});
  });
});

describe('slowestOf', () => {
  test("the selection's slowest first, ties by path, unknown files left out, capped", () => {
    const timings = { 'c.test.ts': 30, 'a.test.ts': 30, 'b.test.ts': 900, 'other.test.ts': 5_000 };
    expect(slowestOf(timings, ['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'])).toEqual([
      { file: 'b.test.ts', ms: 900 },
      { file: 'a.test.ts', ms: 30 },
      { file: 'c.test.ts', ms: 30 },
    ]);
    expect(slowestOf(timings, ['a.test.ts', 'b.test.ts'], 1)).toEqual([
      { file: 'b.test.ts', ms: 900 },
    ]);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i}.test.ts`, i]));
    expect(slowestOf(many, Object.keys(many))).toHaveLength(SLOWEST_KEPT);
    // A key the prototype answers is not a timing.
    expect(slowestOf({}, ['constructor', 'toString'])).toEqual([]);
  });
});

describe('longestFirst', () => {
  test('longest first, ties in their order; an unknown cost is the median of the known', () => {
    expect(longestFirst([10, 50, 10, 30])).toEqual([1, 3, 0, 2]);
    // Known 10, 30, 50 → median 30: the unknown (index 1) ties the 30 (index 3) and goes first.
    expect(longestFirst([10, undefined, 50, 30])).toEqual([2, 1, 3, 0]);
    expect(longestFirst([undefined, undefined])).toEqual([0, 1]);
    expect(longestFirst([])).toEqual([]);
  });

  test('the scheduling it buys: the long slice no longer starts last', () => {
    // Two workers, sorted order puts the 10 at the end: 1+1+1+1 then 10 → 12. Longest first: 10.
    const costs = [1, 1, 1, 1, 10];
    const makespan = (order: readonly number[]): number => {
      const loads = [0, 0];
      for (const index of order) {
        const free = (loads[0] as number) <= (loads[1] as number) ? 0 : 1;
        loads[free] = (loads[free] as number) + (costs[index] as number);
      }
      return Math.max(...loads);
    };
    expect(makespan([0, 1, 2, 3, 4])).toBe(12);
    expect(makespan(longestFirst(costs))).toBe(10);
  });
});

test('costOf: what a group of files is known to cost', () => {
  const timings = { 'a.test.ts': 100, 'b.test.ts': 20 };
  expect(costOf(timings, ['a.test.ts', 'b.test.ts', 'new.test.ts'])).toBe(120);
  expect(costOf(timings, ['new.test.ts'])).toBeUndefined();
  expect(costOf(timings, [])).toBeUndefined();
});
