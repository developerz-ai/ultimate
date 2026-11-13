// The floor applied on the gate: the `exercise` step's own verdict, then the report its child wrote
// judged against `x.verify.json`. A report older than the run is never judged; `x upgrade`'s
// ratchet figure is read from the same file and written without loosening a lower floor.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { EXERCISE_REPORT_FILE } from './exercise-findings';
import {
  measuredExerciseFloor,
  readExerciseRecords,
  withExerciseFloor,
  withUnprovenFloor,
} from './exercise-floor-report';
import type { VerifyContext, VerifyStep } from './verify-step';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const appRoot = async (floor?: object): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'x-exercise-floor-'));
  roots.push(root);
  if (floor !== undefined) await Bun.write(join(root, 'x.verify.json'), JSON.stringify(floor));
  return root;
};

const REPORT = {
  seed: 1,
  records: [
    {
      kind: 'query',
      name: 'feed',
      outcome: 'reached',
      scale: { verdict: 'unproven', reason: 'seed' },
    },
    {
      kind: 'query',
      name: 'list',
      outcome: 'reached',
      tenant: { verdict: 'proven' },
      statementCeiling: { verdict: 'over', statements: 140, max: 100, top: [] },
    },
  ],
};

/** The step the gate runs, as a fake: its child "writes" the report, then answers green. */
const writingStep = (report: unknown): VerifyStep => ({
  name: 'exercise',
  summary: 'fake',
  async run(ctx) {
    if (report !== undefined) {
      await Bun.write(join(ctx.root, EXERCISE_REPORT_FILE), JSON.stringify(report));
    }
    return { ok: true, findings: [] };
  },
});

const ctxOf = (root: string): VerifyContext => ({ root, runner: async () => unreachableRunner() });
const unreachableRunner = (): never => expect.unreachable('the fake step spawns nothing');

describe('unit · withUnprovenFloor', () => {
  test('a declared floor below the pass is red on the step, beside its own findings', async () => {
    const root = await appRoot({ steps: ['exercise'], exercise: { unprovenMax: 0 } });
    const outcome = await withUnprovenFloor(writingStep(REPORT)).run(ctxOf(root));
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.map((one) => one.code)).toEqual(['X_EXERCISE_UNPROVEN_ABOVE_FLOOR']);
  });

  test('no exercise key: green, with the figure to hold and the ceiling as warnings', async () => {
    const root = await appRoot({ steps: ['exercise'] });
    const outcome = await withUnprovenFloor(writingStep(REPORT)).run(ctxOf(root));
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings?.[0]).toContain('"unprovenMax": 0.5');
    expect(outcome.warnings?.[1]).toContain('X_STATEMENTS_OVER_BUDGET');
  });

  test('the child’s copy of a floor code is said once, and alone it does not hold the step red', async () => {
    const root = await appRoot({
      steps: ['exercise'],
      exercise: { unprovenMax: 1, statementsMax: 200 },
    });
    const child: VerifyStep = {
      ...writingStep(REPORT),
      async run(ctx) {
        await writingStep(REPORT).run(ctx);
        const fix = 'x exercise --json';
        return { ok: false, findings: [{ code: 'X_STATEMENTS_OVER_BUDGET', cause: 'c', fix }] };
      },
    };
    const outcome = await withUnprovenFloor(child).run(ctxOf(root));
    expect(outcome.ok).toBe(true);
    expect(outcome.findings).toEqual([]);
    // Under its floor, the ratchet names the lower figure.
    expect(outcome.warnings).toEqual([expect.stringContaining('lower it to')]);
  });

  test('a report the run did not rewrite is not this run’s: it is not judged', async () => {
    const root = await appRoot({ steps: ['exercise'], exercise: { unprovenMax: 0 } });
    await Bun.write(join(root, EXERCISE_REPORT_FILE), JSON.stringify(REPORT));
    const outcome = await withUnprovenFloor(writingStep(undefined)).run(ctxOf(root));
    expect(outcome).toEqual({ ok: true, findings: [] });
  });

  test('a report that does not parse leaves the step’s own verdict alone', async () => {
    const root = await appRoot({ steps: ['exercise'], exercise: { unprovenMax: 0 } });
    const outcome = await withUnprovenFloor(writingStep({ records: 'no' })).run(ctxOf(root));
    expect(outcome).toEqual({ ok: true, findings: [] });
  });
});

describe('unit · the ratchet x upgrade writes', () => {
  test('the measured figure is the last report’s', async () => {
    const root = await appRoot();
    expect(await measuredExerciseFloor(root)).toBeUndefined();
    await Bun.write(join(root, EXERCISE_REPORT_FILE), JSON.stringify(REPORT));
    expect(await measuredExerciseFloor(root)).toEqual({ unprovenMax: 0.5, statementsMax: 140 });
    expect(await readExerciseRecords(root)).toHaveLength(2);
  });

  test("a declared ceiling's `declared` survives the report read", async () => {
    const root = await appRoot();
    const ceiling = { verdict: 'within', statements: 90, max: 100, declared: true } as const;
    const record = { kind: 'query', name: 'bulk', outcome: 'reached', statementCeiling: ceiling };
    await Bun.write(join(root, EXERCISE_REPORT_FILE), JSON.stringify({ records: [record] }));
    expect((await readExerciseRecords(root))?.[0]?.statementCeiling).toEqual(ceiling);
  });

  test('written beside every other key; a lower floor is kept, a higher one falls', () => {
    const text = JSON.stringify({ steps: ['unit'], exercise: { statementsMax: 100 } });
    expect(JSON.parse(withExerciseFloor(text, { unprovenMax: 0.2 }))).toEqual({
      steps: ['unit'],
      exercise: { statementsMax: 100, unprovenMax: 0.2 },
    });
    const lower = JSON.stringify({ steps: [], exercise: { unprovenMax: 0.1 } });
    expect(withExerciseFloor(lower, { unprovenMax: 0.2 })).toBe(lower);
    const higher = JSON.stringify({ steps: [], exercise: { unprovenMax: 0.9 } });
    expect(JSON.parse(withExerciseFloor(higher, { unprovenMax: 0.2 })).exercise.unprovenMax).toBe(
      0.2,
    );
    expect(withExerciseFloor('not json', { unprovenMax: 0.2 })).toBe('not json');
  });
});
