// A unit cut into parts and folded back: the weight-band plan, a part's document, and the fold the
// bar judges — lines exactly, functions at the best part's count, a missing part refused.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the artifact directories are a real tree on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { parseLcov } from '../../packages/cli/src/coverage-lcov';
import type { UnitPart } from './coverage-parts';
import {
  coverageFiles,
  foldParts,
  ownCoverage,
  PART_MS,
  partDocument,
  partFile,
  partName,
  planParts,
  readPartDocument,
  readParts,
  renderLcov,
  unitOfName,
} from './coverage-parts';

const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'f.test.ts'];
const weights = {
  'a.test.ts': 10,
  'b.test.ts': 500,
  'c.test.ts': 20,
  'd.test.ts': 480,
  'e.test.ts': 30,
  'f.test.ts': 40,
};

describe('planParts — how a unit is cut', () => {
  test('a unit under PART_MS is one part: the whole suite, every file', () => {
    const plan = planParts('core', files, weights, 2000);
    expect(plan).toEqual([{ unit: 'core', index: 1, total: 1, files }]);
  });

  test('over it, ceil(weight / PART_MS) parts, heaviest band first, every file exactly once', () => {
    // 1080 ms over a 600 ms part: two parts, the band of the two heavy files and the light rest.
    const plan = planParts('cli', files, weights, 600);
    expect(plan.map((part) => part.files)).toEqual([
      ['b.test.ts', 'd.test.ts'],
      ['a.test.ts', 'c.test.ts', 'e.test.ts', 'f.test.ts'],
    ]);
    expect(plan.map(partName)).toEqual(['cli#1/2', 'cli#2/2']);
    expect(plan.flatMap((part) => part.files).sort()).toEqual(files);
  });

  test('the part count follows the weight: a heavier suite is cut into more parts', () => {
    expect(planParts('cli', files, weights, 400)).toHaveLength(3);
    expect(planParts('cli', files, weights, 1080)).toHaveLength(1);
    expect(planParts('cli', files, weights, 1079)).toHaveLength(2);
  });

  test('a file the weights do not know costs their median, so a new file still counts', () => {
    // Median of the six is 40: `new.test.ts` lifts 1080 to 1120, past one 1100 ms part.
    expect(planParts('cli', files, weights, 1100)).toHaveLength(1);
    expect(planParts('cli', [...files, 'new.test.ts'], weights, 1100)).toHaveLength(2);
  });

  test('one file heavier than several shares leaves no empty part', () => {
    const plan = planParts('cli', ['huge.test.ts', 'x.test.ts'], { 'huge.test.ts': 9000 }, 1000);
    expect(plan.map((part) => part.files)).toEqual([['huge.test.ts'], ['x.test.ts']]);
    expect(plan.map((part) => part.total)).toEqual([2, 2]);
  });

  test('one tree cuts one way: the order the files arrive in does not move a file', () => {
    expect(planParts('cli', [...files].reverse(), weights, 600)).toEqual(
      planParts('cli', files, weights, 600),
    );
  });

  test('PART_MS keeps a part under the five-minute target on four workers', () => {
    // ~1.26× the weights under coverage (measured on `cli`), over four workers.
    expect((PART_MS * 1.26) / 4 / 1000).toBeLessThan(300);
  });
});

test('a scheduled name answers its unit; a part file is named by its place in the plan', () => {
  expect(unitOfName('cli#2/3')).toBe('cli');
  expect(unitOfName('core')).toBe('core');
  expect(partFile({ unit: 'cli', index: 2, total: 3 })).toBe('cli.2-of-3.json');
});

test('a coverage run never runs an e2e path: they are the e2e step’s', () => {
  expect(
    coverageFiles([
      'packages/cli/src/z.test.ts',
      'packages/cli/e2e/upgrade.e2e.test.ts',
      'packages/cli/src/a.e2e.test.ts',
      'packages/cli/src/a.test.ts',
    ]),
  ).toEqual(['packages/cli/src/a.test.ts', 'packages/cli/src/z.test.ts']);
});

/** One lcov record, Bun's shape. */
const record = (file: string, fn: [number, number], da: [number, number][]): string =>
  [
    `SF:${file}`,
    `FNF:${String(fn[0])}`,
    `FNH:${String(fn[1])}`,
    ...da.map(([line, hits]) => `DA:${String(line)},${String(hits)}`),
    `LF:${String(da.length)}`,
    `LH:${String(da.filter(([, hits]) => hits > 0).length)}`,
    'end_of_record',
  ].join('\n');

const own = (file: string): boolean => file.startsWith('packages/cli/src/');

describe('foldParts — the parts back into one reading', () => {
  const plan: readonly UnitPart[] = [
    { unit: 'cli', index: 1, total: 2, files: ['packages/cli/src/heavy.test.ts'] },
    { unit: 'cli', index: 2, total: 2, files: ['packages/cli/src/light.test.ts'] },
  ];
  const run = { seconds: 10, workers: 4 };
  const heavy = partDocument(
    plan[0] as UnitPart,
    ownCoverage(
      `${record(
        'packages/cli/src/a.ts',
        [4, 3],
        [
          [1, 1],
          [2, 0],
          [3, 1],
        ],
      )}\n${record('packages/core/src/x.ts', [1, 1], [[1, 1]])}`,
      own,
    ),
    run,
  );
  const light = partDocument(
    plan[1] as UnitPart,
    ownCoverage(
      record(
        'packages/cli/src/a.ts',
        [4, 2],
        [
          [1, 1],
          [2, 1],
          [3, 0],
        ],
      ),
      own,
    ),
    { seconds: 30, workers: 4 },
  );

  test('a part keeps only the unit’s own source', () => {
    expect(Object.keys(heavy.coverage)).toEqual(['packages/cli/src/a.ts']);
  });

  test('lines are a union; functions are the best part’s count, never a sum', () => {
    const folded = foldParts(plan, [heavy, light]);
    if ('code' in folded) return expect.unreachable(folded.cause);
    const [file] = parseLcov(folded.lcov);
    expect(file?.file).toBe('packages/cli/src/a.ts');
    expect([file?.linesHit, file?.linesFound]).toEqual([3, 3]);
    // 3 and 2 of 4: the union is somewhere in 3..4, and only 3 is known. 5 would be a lie.
    expect([file?.funcsHit, file?.funcsFound]).toEqual([3, 4]);
    // The slowest part is the unit's wall clock; the workers are every part's.
    expect([folded.seconds, folded.workers]).toEqual([30, 8]);
  });

  test('a part that never reported is X_COVERAGE_UNMEASURED, never a reading of the rest', () => {
    const folded = foldParts(plan, [heavy]);
    if (!('code' in folded)) return expect.unreachable('a fold with a part missing was read');
    expect(folded.code).toBe('X_COVERAGE_UNMEASURED');
    expect(folded.cause).toContain('cli#2/2 never reported');
    expect(folded.fix).toStartWith('bun run scripts/coverage-gate.ts --package cli --json');
  });

  test('a part cut from another plan is refused: two trees are never folded together', () => {
    const moved = [
      plan[0] as UnitPart,
      { ...(plan[1] as UnitPart), files: ['packages/cli/src/other.test.ts'] },
    ];
    const folded = foldParts(moved, [heavy, light]);
    if (!('code' in folded)) return expect.unreachable('a part of another plan was folded');
    expect(folded.cause).toContain('another set of test files');
    const resized = plan.map((part) => ({ ...part, total: 3 }));
    expect('code' in foldParts(resized, [heavy, light])).toBe(true);
  });

  test('a document survives the disk; anything else is not one', () => {
    expect(readPartDocument(JSON.parse(JSON.stringify(heavy)))).toEqual(heavy);
    expect(readPartDocument({ ...heavy, coverage: 'x' })).toBeUndefined();
    expect(readPartDocument({ ...heavy, index: '1' })).toBeUndefined();
    expect(readPartDocument(null)).toBeUndefined();
  });
});

test('readParts: every document under the download, a re-run attempt ahead of the first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coverage-parts-'));
  try {
    const doc = {
      unit: 'cli',
      index: 1,
      total: 2,
      deal: 'd',
      seconds: 1,
      workers: 4,
      coverage: {},
    };
    await Bun.write(join(dir, 'coverage-part-0-attempt-1/cli.1-of-2.json'), JSON.stringify(doc));
    await Bun.write(
      join(dir, 'coverage-part-0-attempt-2/cli.1-of-2.json'),
      JSON.stringify({ ...doc, seconds: 2 }),
    );
    await Bun.write(join(dir, 'coverage-part-1-attempt-1/broken.json'), '{ not json');
    await Bun.write(join(dir, 'coverage-part-1-attempt-1/other.json'), '{"a":1}');
    const docs = await readParts(dir);
    expect(docs.map((one) => one.seconds)).toEqual([2, 1]);
    expect(await readParts(join(dir, 'never-downloaded'))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderLcov writes what parseLcov reads, so a fold is read as a whole unit is', () => {
  const lcov = record(
    'packages/cli/src/a.ts',
    [5, 2],
    [
      [3, 1],
      [1, 0],
      [7, 2],
    ],
  );
  const [back] = parseLcov(renderLcov(ownCoverage(lcov, own)));
  expect(back).toMatchObject({ linesFound: 3, linesHit: 2, funcsFound: 5, funcsHit: 2 });
  expect([...(back?.lines ?? new Map()).keys()]).toEqual([1, 3, 7]);
  expect(renderLcov({})).toBe('');
});
