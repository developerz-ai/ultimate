// An action and a job sharing a name are two primitives with two entries: a kind-qualified key
// (`'job:ekdErase'`) is that kind's alone and wins over the bare name, each runs as its own record,
// and the paste line a shared name prints is the qualified key.

import { afterAll, describe, expect, test } from 'bun:test';
import { action } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { DEFAULT_RETRY, job, t } from '@ultimat3/jobs';
import { allow } from '@ultimat3/policy';
import type { ExerciseOverride } from './define-exercise';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const orgs = entity('ekd_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(orgs).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

/** Reached only with the word no draw makes: the action needs its entry's input. */
registerActions({
  ekdErase: action({
    input: t.object({ word: t.string.max(20) }),
    output: t.object({ ok: t.boolean }),
    policy: allow('the entry key is the subject here, not the policy'),
    handle: ({ input }) => {
      if (input.word === 'please') return { ok: true };
      throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'no such word', fix: 'say please' });
    },
  }),
});
/** Its input needs a reason: the action entry's `{ word }`, with none in it, is drift here. */
job({
  name: 'ekdErase',
  tenant: (input) => input.ekdOrgId,
  input: t.object({ ekdOrgId: t.uuid, ekdReason: t.string.min(1).max(20) }),
  idempotencyKey: (input) => input.ekdOrgId,
  retry: { ...DEFAULT_RETRY, attempts: 1 },
  run: async () => undefined,
});

const please: ExerciseOverride = { input: () => ({ word: 'please' }) };

const pass = async (entries: Readonly<Record<string, ExerciseOverride>>) => {
  const records = await runExercisePass({
    entities: [orgs],
    writer,
    roles: () => [{ name: 'anonymous', actor: null }],
    only: 'ekdErase',
    overrides: defineExercise(entries),
  });
  const of = (kind: ExerciseRecord['kind']) =>
    records.find((record) => record.kind === kind) as ExerciseRecord;
  expect(records.map((record) => record.kind).sort()).toEqual(['action', 'job']);
  return { action: of('action'), job: of('job') };
};

describe(testName('unit', 'runExercisePass · one name, two kinds'), () => {
  test('a bare key alone feeds the job the action input: the job drifts, told its own key', async () => {
    const { action: done, job: drifted } = await pass({ ekdErase: please });
    expect(done.outcome).toBe('reached');
    expect(drifted).toMatchObject({ outcome: 'unreached', code: 'X_CONTRACT_DRIFT' });
    expect(drifted.override).toStartWith('"job:ekdErase": {');
  });

  test("a qualified key is that kind's alone: the job keeps the pass's own draw", async () => {
    const { action: done, job: alone } = await pass({ 'action:ekdErase': please });
    expect(done.outcome).toBe('reached');
    expect(alone.outcome).toBe('reached');
  });

  test('a qualified key wins over the bare one for its kind', async () => {
    const { action: done, job: own } = await pass({
      ekdErase: please,
      'job:ekdErase': { input: (drawn) => drawn },
    });
    expect(done.outcome).toBe('reached');
    expect(own.outcome).toBe('reached');
  });

  test('a key qualified by a kind the name is not registered as is X_DECLARATION_UNKNOWN', async () => {
    const failure = await pass({ 'query:ekdErase': please }).then(
      () => expect.unreachable('the pass ran'),
      (error: unknown) => error,
    );
    expect(isUltimateError(failure) && failure.code).toBe('X_DECLARATION_UNKNOWN');
  });
});
