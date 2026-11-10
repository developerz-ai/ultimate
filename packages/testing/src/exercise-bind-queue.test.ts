// An override's input and the call it feeds share ONE job queue: a job the input enqueues is still
// there when the call looks it up by id. What the input queued is never the primitive's enqueue;
// what the call queued still is.

import { describe, expect, test } from 'bun:test';
import { action, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { UltimateError } from '@ultimat3/core';
import { DEFAULT_RETRY, job, jobDriver } from '@ultimat3/jobs';
import { allow } from '@ultimat3/policy';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const writer: SeedWriter = {
  insert: async () => undefined,
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

const ebqAudit = job({
  name: 'ebqAudit',
  tenant: 'none',
  input: t.object({ by: t.string.max(40) }),
  idempotencyKey: (input) => input.by,
  retry: { ...DEFAULT_RETRY, attempts: 1 },
  run: async () => undefined,
});

/** Finds the job by id on the ambient driver, as an admin action's cancel does; then queues one. */
const lookUp = (queues: boolean) =>
  action({
    input: t.object({ jobId: t.string.max(80) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the job lookup is the subject here, not the policy'),
    async handle({ input }) {
      const found = await jobDriver()?.introspect?.job(input.jobId);
      if (found === undefined) {
        throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'no such job', fix: 'enqueue it' });
      }
      if (queues) await ebqAudit.enqueue({ by: crypto.randomUUID() });
      return { ok: true };
    },
  });
registerActions({ ebqFind: lookUp(false), ebqFindAndQueue: lookUp(true) });

const pass = async (only: string): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [],
    writer,
    roles: () => [{ name: 'anonymous', actor: null }],
    only,
    overrides: defineExercise({
      [only]: {
        input: async (drawn) => {
          const row = await ebqAudit.enqueue({ by: crypto.randomUUID() });
          return { ...drawn, jobId: row.id };
        },
      },
    }),
  });
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass · the input and the call share a queue'), () => {
  test('a job the input enqueued is found by the call, and is not the record', async () => {
    const record = await pass('ebqFind');
    expect(record).toMatchObject({ outcome: 'reached' });
    expect(record.effects).toEqual([]);
    // The scale sweep's binds share their sized call's queue too: a verdict, never `unproven`.
    expect(record.scale?.verdict).not.toBe('unproven');
  });

  test('a job the call enqueued is still its enqueue effect, the input’s excepted', async () => {
    const record = await pass('ebqFindAndQueue');
    expect(record).toMatchObject({ outcome: 'reached' });
    expect(record.effects).toEqual([{ kind: 'enqueue', job: 'ebqAudit', count: 1 }]);
  });
});
