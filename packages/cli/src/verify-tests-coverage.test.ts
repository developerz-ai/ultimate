// An APP's `unit` step holds the coverage floor; a root that is not an app is untouched; a
// `--shard` slice defers to `x verify merge`. Real `bun test` processes over a real tree: the
// thing under test is what Bun's lcov says, and a fake runner would be testing the fake.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import { exec } from './exec';
import { renderJson } from './output';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import { coverageRiders, mergeParts, parsePart } from './verify-merge';
import { runVerify } from './verify-run';
import type { VerifyContext } from './verify-step';
import { resetTestDiscovery, TEST_STEPS } from './verify-tests';

let root = '';

const TEST = (name: string, importPath: string, call: string): string =>
  `import { expect, test } from 'bun:test';\nimport * as m from '${importPath}';\ntest('${name}', () => {\n  expect(${call}).toBeDefined();\n});\n`;

/** Two fully covered modules in two directories, so a 2-way shard splits them. */
async function writeApp(dir: string): Promise<void> {
  await Bun.write(join(dir, APP_CONFIG_FILE), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, 'apps/web/app/a/a.ts'), 'export const a = (): number => 1;\n');
  await Bun.write(join(dir, 'apps/web/app/a/a.test.ts'), TEST('a', './a', 'm.a()'));
  await Bun.write(join(dir, 'apps/web/app/b/b.ts'), 'export const b = (): number => 2;\n');
  await Bun.write(join(dir, 'apps/web/app/b/b.test.ts'), TEST('b', './b', 'm.b()'));
}

const floorFile = (body: Record<string, unknown>): Promise<number> =>
  Bun.write(join(root, VERIFY_FLOOR_FILE), JSON.stringify({ steps: ['unit'], ...body }));

const unitRun = (extra: Partial<VerifyContext> = {}) => {
  resetTestDiscovery();
  return runVerify(TEST_STEPS, { root, runner: exec, workers: 2, only: 'unit', ...extra });
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-verify-unit-coverage-'));
  await writeApp(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('an app’s unit step', () => {
  test('with no floor stated is red on the floor alone, carrying the line to add', async () => {
    await floorFile({});
    const result = await unitRun();
    const [unit] = result.steps ?? [];
    expect(unit?.ok).toBe(false);
    expect(unit?.tests).toEqual({ ran: 2, skipped: 0 });
    expect(unit?.findings.map((finding) => finding.code)).toEqual(['X_COVERAGE_FLOOR_UNSTATED']);
    expect(unit?.findings[0]?.fix).toBe(
      'edit x.verify.json — add "coverage": { "lines": 95, "funcs": 95 }',
    );
    expect(unit?.output).toContain('100.0% of lines, 100.0% of functions over 2 source file(s)');
  });

  test('at the stated floor is green, and says what it measured', async () => {
    await floorFile({ coverage: { lines: 95, funcs: 95 } });
    const result = await unitRun();
    const [unit] = result.steps ?? [];
    expect(unit?.ok).toBe(true);
    expect(unit?.findings).toEqual([]);
    expect(unit?.output).toContain('floor 95.0% / 95.0%');
    // `--json` drops a green step's output, so the numbers are in `data` too.
    expect((result.data as { coverage?: unknown }).coverage).toEqual({
      unit: { lines: 100, funcs: 100, files: 2 },
    });
  });

  test('deleting one test file turns it red, naming the file nothing loads any more', async () => {
    await floorFile({ coverage: { lines: 95, funcs: 95 } });
    const moved = join(root, 'apps/web/app/b/b.test.ts');
    const text = await Bun.file(moved).text();
    await rm(moved);
    try {
      const result = await unitRun();
      const [unit] = result.steps ?? [];
      expect(unit?.ok).toBe(false);
      expect(unit?.findings.map((finding) => finding.code)).toEqual(['X_COVERAGE_BELOW_FLOOR']);
      expect(unit?.findings[0]?.cause).toContain('apps/web/app/b/b.ts (no unit test loads it');
      expect(unit?.findings[0]?.at).toBe('apps/web/app/b/b.ts');
    } finally {
      await Bun.write(moved, text);
    }
  });

  test('a red suite is reported as the suite, never as coverage', async () => {
    await floorFile({ coverage: { lines: 95, funcs: 95 } });
    const red = join(root, 'apps/web/app/a/red.test.ts');
    await Bun.write(
      red,
      "import { expect, test } from 'bun:test';\ntest('red', () => {\n  expect(1).toBe(2);\n});\n",
    );
    try {
      const [unit] = (await unitRun()).steps ?? [];
      expect(unit?.findings.map((finding) => finding.code)).toEqual(['X_TEST_FAILED']);
    } finally {
      await rm(red);
    }
  });

  test('a file whose describe body throws is red — bun prints "0 fail" beside "1 error"', async () => {
    await floorFile({ coverage: { lines: 95, funcs: 95 } });
    const errored = join(root, 'apps/web/app/a/errored.test.ts');
    await Bun.write(
      errored,
      "import { describe } from 'bun:test';\ndescribe('boom', () => {\n  throw new TypeError('describe body threw');\n});\n",
    );
    try {
      const [unit] = (await unitRun()).steps ?? [];
      expect(unit?.ok).toBe(false);
      expect(unit?.findings.map((finding) => finding.code)).toEqual(['X_TEST_FAILED']);
      expect(unit?.tests).toEqual({ ran: 2, skipped: 0, errors: 1 });
      expect(unit?.output).toContain('describe body threw');
    } finally {
      await rm(errored);
    }
  });
});

describe('a root that is not an app', () => {
  test('runs the suite and judges no coverage: the framework’s floor is per package', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'ultimate-verify-unit-bare-'));
    try {
      await writeApp(bare);
      await rm(join(bare, APP_CONFIG_FILE));
      resetTestDiscovery();
      const result = await runVerify(TEST_STEPS, {
        root: bare,
        runner: exec,
        workers: 2,
        only: 'unit',
      });
      const [unit] = result.steps ?? [];
      expect(unit?.ok).toBe(true);
      expect(unit?.tests).toEqual({ ran: 2, skipped: 0 });
      expect(unit?.output).toBeUndefined();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('a sharded unit step', () => {
  const shardPart = async (index: number, total: number) => {
    const result = await unitRun({ shard: { index, total } });
    return { result, part: parsePart(`unit-${String(index)}.json`, renderJson(result)) };
  };

  test('a shard defers the floor and hands its facts over; the merge judges the fold', async () => {
    await floorFile({ coverage: { lines: 95, funcs: 95 } });
    const one = await shardPart(1, 2);
    const two = await shardPart(2, 2);
    // Each shard alone covers half the app — and is green, because the floor is not its to judge.
    for (const { result } of [one, two]) {
      expect(result.ok).toBe(true);
      expect(result.steps?.[0]?.findings).toEqual([]);
      expect(result.steps?.[0]?.output).toContain('x verify merge folds every shard');
    }
    expect(Object.keys(one.part.coverage?.['unit'] ?? {})).toEqual(['apps/web/app/a/a.ts']);
    const parts = [one.part, two.part];
    const floor = {
      steps: ['unit'],
      problems: [],
      coverage: { lines: 95, funcs: 95, exclude: [] },
    };
    const riders = await coverageRiders(parts, root, floor);
    expect(riders['unit']?.findings).toEqual([]);
    const merged = mergeParts(parts, floor, ['unit'], { riders });
    expect(merged.ok).toBe(true);
    expect(merged.steps?.[0]?.output).toContain('100.0% of lines');

    // The floor one shard would have failed alone is failed by the merge when a shard is absent
    // from the fold — a split cannot skip the floor by saying nothing.
    const half = await coverageRiders(
      [{ ...one.part }, { ...two.part, coverage: {} }],
      root,
      floor,
    );
    expect(half['unit']?.findings.map((finding) => finding.code)).toEqual([
      'X_COVERAGE_BELOW_FLOOR',
    ]);
    const red = mergeParts(parts, floor, ['unit'], { riders: half });
    expect(red.ok).toBe(false);
    expect(red.steps?.[0]?.findings.map((finding) => finding.code)).toEqual([
      'X_COVERAGE_BELOW_FLOOR',
    ]);
  });

  test('no floor stated is the merge’s finding too', async () => {
    const { part } = await shardPart(1, 1);
    const riders = await coverageRiders([part], root, { steps: ['unit'], problems: [] });
    expect(riders['unit']?.findings.map((finding) => finding.code)).toEqual([
      'X_COVERAGE_FLOOR_UNSTATED',
    ]);
  });

  test('a red shard, a whole run and a root that is not an app carry no rider', async () => {
    const { part } = await shardPart(1, 1);
    const [step] = part.steps;
    if (step === undefined) expect.unreachable('the part holds the unit step');
    const floor = { steps: ['unit'], problems: [] };
    expect(
      await coverageRiders([{ ...part, steps: [{ ...step, ok: false }] }], root, floor),
    ).toEqual({});
    const { shard: _shard, ...whole } = step;
    expect(await coverageRiders([{ ...part, steps: [whole] }], root, floor)).toEqual({});
    expect(await coverageRiders([part], tmpdir(), floor)).toEqual({});
  });
});
