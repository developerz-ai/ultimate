// The hop's exercise ratchet: the figures the hop's own pass measured, written only for the keys
// the app's `x.verify.json` lacks — so an upgraded app's gate holds where it is, and stays green.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove primitive.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { EXERCISE_REPORT_FILE } from './exercise-findings';
import { exerciseFloorVerdict } from './exercise-floor-verdict';
import { ratchetExerciseFloor } from './upgrade-exercise-floor';
import { readVerifyFloor } from './verify-floor';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const RECORDS = [
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
    statementCeiling: { verdict: 'over', statements: 140, max: 100, top: [] },
  },
];

const app = async (floor: object | undefined, report = true): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'x-upgrade-exercise-'));
  roots.push(root);
  if (floor !== undefined) await Bun.write(join(root, 'x.verify.json'), JSON.stringify(floor));
  if (report) {
    await Bun.write(join(root, EXERCISE_REPORT_FILE), JSON.stringify({ records: RECORDS }));
  }
  return root;
};

describe('unit · ratchetExerciseFloor', () => {
  test('an app with no exercise key gets the measured figures, and its gate is then green', async () => {
    const root = await app({ steps: ['exercise'] });
    expect(await ratchetExerciseFloor(root)).toEqual({
      file: 'x.verify.json',
      written: { unprovenMax: 0.5, statementsMax: 140 },
    });
    const floor = await readVerifyFloor(root);
    expect(floor?.steps).toEqual(['exercise']);
    const records = (await Bun.file(join(root, EXERCISE_REPORT_FILE)).json()).records;
    expect(exerciseFloorVerdict(records, floor?.exercise).findings).toEqual([]);
  });

  test('a key the app already wrote is never touched; only the missing one is written', async () => {
    const root = await app({ steps: [], exercise: { unprovenMax: 0 } });
    expect((await ratchetExerciseFloor(root))?.written).toEqual({ statementsMax: 140 });
    expect((await readVerifyFloor(root))?.exercise).toEqual({ unprovenMax: 0, statementsMax: 140 });
  });

  test('no floor file, no report, or a malformed key: nothing is written', async () => {
    expect(await ratchetExerciseFloor(await app(undefined))).toBeNull();
    expect(await ratchetExerciseFloor(await app({ steps: [] }, false))).toBeNull();
    const bad = await app({ steps: [], exercise: { unprovenMax: 'lots' } });
    expect(await ratchetExerciseFloor(bad)).toBeNull();
  });
});
