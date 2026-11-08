// What an override's `input` sends is the entry's, never the primitive's: the control records each
// call alone, so a select the input runs (to find a row, to mint a challenge) is no statement of
// the record's — and so never planned as the primitive's by the plan sweep. A job it enqueues has
// a driver, as the call does, and is not the primitive's enqueue either.

import { afterAll, describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { useContext } from '@ultimat3/core';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import { allow, testActor } from '@ultimat3/policy';
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
  eisSized: action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the sweep binding is the subject here, not the policy'),
    handle: () => ({ ok: true }),
  }),
  eisQuiet: action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the statements are the subject here, not the policy'),
    handle: () => ({ ok: true }),
  }),
});

/** What an input enqueues: an audit the app's own helper queues while it mints a challenge. */
const eisAudit = job({
  name: 'eisAudit',
  tenant: 'none',
  input: t.object({ by: t.string.max(40) }),
  idempotencyKey: (input) => input.by,
  retry: { ...DEFAULT_RETRY, attempts: 1 },
  run: async () => undefined,
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

  test('an async input that enqueues a job has a driver on every call, and the job is not the record', async () => {
    const records = await runExercisePass({
      entities: [items],
      writer,
      roles: () => [{ name: 'anonymous', actor: null }],
      only: 'eisQuiet',
      overrides: defineExercise({
        eisQuiet: {
          input: async (drawn) => {
            await eisAudit.enqueue({ by: crypto.randomUUID() });
            return { ...drawn, word: 'ok' };
          },
        },
      }),
    });
    const record = records[0] as ExerciseRecord;
    expect(record).toMatchObject({ outcome: 'reached', effects: [] });
  });

  test("the scale sweep's binds run as the sweep's actor, each with a driver: the scale proof is a verdict", async () => {
    const orgs: (string | undefined)[] = [];
    const records = await runExercisePass({
      entities: [items],
      writer,
      roles: (tenant) => [testActor('writer', { orgId: tenant })],
      only: 'eisSized',
      overrides: defineExercise({
        eisSized: {
          input: async (drawn) => {
            orgs.push(useContext().actor.orgId);
            // Only the sweep's binds enqueue: the first two (tenant proof, control) are A's.
            if (orgs.length > 2) await eisAudit.enqueue({ by: crypto.randomUUID() });
            return { ...drawn, word: 'ok' };
          },
        },
      }),
    });
    const record = records[0] as ExerciseRecord;
    expect(record.outcome).toBe('reached');
    expect(record.scale?.verdict).not.toBe('unproven');
    // A's tenant, then each sized graph's: the seated actor of every call the bind feeds.
    expect(new Set(orgs).size).toBeGreaterThanOrEqual(3);
  });
});
