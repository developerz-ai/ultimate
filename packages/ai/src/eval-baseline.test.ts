import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalBaseline } from './eval-baseline';
import {
  baselinePath,
  describeRegression,
  OVERALL,
  readBaseline,
  regressionsAgainst,
  writeBaseline,
} from './eval-baseline';

const BASELINE: EvalBaseline = {
  eval: 'summarize',
  prompt: 'posts.summarize@3',
  promptHash: 'abc123',
  score: 0.9,
  cases: { alpha: 0.95, beta: 0.85 },
};

async function inTemporaryDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-baseline-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('unit · where a baseline lives', () => {
  test('a file URL and an absolute path resolve; a relative one names the fix', () => {
    expect(baselinePath('file:///tmp/x.baseline.json', 'summarize')).toBe('/tmp/x.baseline.json');
    expect(baselinePath('/tmp/x.baseline.json', 'summarize')).toBe('/tmp/x.baseline.json');

    // A cwd-relative path resolves differently depending on where the suite started, which is
    // how a gate silently stops gating — so it is refused with the one form that always works.
    try {
      baselinePath('./x.baseline.json', 'summarize');
      throw new Error('expected a refusal');
    } catch (error) {
      const thrown = error as { code?: unknown; fix?: unknown };
      expect(thrown.code).toBe('X_EVAL_BASELINE_MISSING');
      expect(String(thrown.fix)).toContain("import.meta.resolve('./x.baseline.json')");
    }
  });
});

describe('unit · reading and writing recorded scores', () => {
  test('an unrecorded eval reads as absent, not as an error', async () => {
    await inTemporaryDir(async (dir) => {
      expect(await readBaseline(join(dir, 'nothing.json'))).toBeUndefined();
    });
  });

  test('a round trip sorts cases, rounds to three decimals and ends in a newline', async () => {
    await inTemporaryDir(async (dir) => {
      const path = join(dir, 'x.baseline.json');
      await writeBaseline(path, {
        ...BASELINE,
        score: 0.9166666,
        cases: { zeta: 0.3333333, alpha: 1 },
      });
      const text = await Bun.file(path).text();
      expect(text.endsWith('\n')).toBe(true);
      expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'));
      expect(await readBaseline(path)).toEqual({
        ...BASELINE,
        score: 0.917,
        cases: { alpha: 1, zeta: 0.333 },
      });
    });
  });

  test('a corrupt baseline throws rather than reading as absent', async () => {
    await inTemporaryDir(async (dir) => {
      const notJson = join(dir, 'broken.json');
      await Bun.write(notJson, 'not json at all');
      // Absent would mean "record me"; corrupt means the gate lost its reference point. A
      // silent pass here would erase the only thing standing between a prompt and production.
      await expect(readBaseline(notJson)).rejects.toMatchObject({
        code: 'X_EVAL_BASELINE_INVALID',
      });

      const wrongShape = join(dir, 'wrong.json');
      await Bun.write(wrongShape, JSON.stringify({ ...BASELINE, cases: { alpha: 'high' } }));
      await expect(readBaseline(wrongShape)).rejects.toMatchObject({
        code: 'X_EVAL_BASELINE_INVALID',
      });
    });
  });
});

describe('unit · what counts as a regression', () => {
  const against = (score: number, cases: Record<string, number>, tolerance = 0.05) =>
    regressionsAgainst({ baseline: BASELINE, score, cases, tolerance });

  test('a drop within tolerance is drift; beyond it is a regression', () => {
    expect(against(0.86, { alpha: 0.95, beta: 0.85 })).toEqual([]);
    expect(against(0.84, { alpha: 0.95, beta: 0.85 })).toEqual([
      { case: OVERALL, baseline: 0.9, score: 0.84 },
    ]);
  });

  test('a drop of exactly the tolerance is still within it', () => {
    expect(against(0.85, { alpha: 0.95, beta: 0.85 })).toEqual([]);
  });

  test('a case is compared on its own, and only when the baseline knows it', () => {
    expect(against(0.9, { alpha: 0.5, beta: 0.85, gamma: 0 })).toEqual([
      { case: 'alpha', baseline: 0.95, score: 0.5 },
    ]);
  });

  test('an improvement is never a regression', () => {
    expect(against(1, { alpha: 1, beta: 1 })).toEqual([]);
  });

  test('a regression reads as the two numbers in the order they happened', () => {
    expect(describeRegression({ case: 'alpha', baseline: 0.95, score: 0.5 })).toBe(
      'alpha 0.50 ← 0.95',
    );
  });
});
