// What an override's `input` sends is the entry's, never the primitive's: the control records each
// call alone, so a select the input runs (to find a row, to mint a challenge) is no statement of
// the record's — and so never planned as the primitive's by the plan sweep.

import { afterAll, describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const items = entity('eis_items', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(items).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

registerActions({
  eisQuiet: action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the statements are the subject here, not the policy'),
    handle: () => ({ ok: true }),
  }),
});

describe(testName('unit', 'runExercisePass · what the input sends'), () => {
  test("an async input's select and insert are not the primitive's statements or effects", async () => {
    const records = await runExercisePass({
      entities: [items],
      writer,
      roles: () => [{ name: 'anonymous', actor: null }],
      only: 'eisQuiet',
      overrides: defineExercise({
        eisQuiet: {
          runs: 2,
          input: async (drawn) => {
            await driver.repo(items).findMany();
            await driver.repo(items).insert({ id: crypto.randomUUID(), name: 'by the input' });
            return { ...drawn, word: 'ok' };
          },
        },
      }),
    });
    const record = records[0] as ExerciseRecord;
    expect(record.outcome).toBe('reached');
    expect(record.statements).toBe(0);
    expect(record.effects).toEqual([]);
  });
});
