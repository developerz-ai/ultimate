// The exercise pass over a small app on the memory driver, no database: a handler that throws is
// unreached, a call out is refused and counted, a mutated handler changes the outcome, an override
// wins, an unknown override name refuses, and `off` needs a reason.

import { describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { isUltimateError, UltimateError } from '@ultimat3/core';
import { database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import type { NamedActor } from '@ultimat3/policy';
import { can, testActor } from '@ultimat3/policy';
import { from, query, registerQueries } from '@ultimat3/query';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('exp_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const notes = entity('exp_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});
const driver = memoryDriver();
const db = database({ orgs, notes }, { driver });
const writer: SeedWriter = {
  insert: async ({ entity: name, row }) => {
    if (name === orgs.$name) await driver.repo(orgs).insert(row as never);
    else await driver.repo(notes).insert(row as never);
  },
  update: async () => undefined,
  // The write half reads nothing here: `tenant-proof.test.ts` proves it on a real store.
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};
const roles = (tenant: string): readonly NamedActor[] => [
  { name: 'anonymous', actor: null },
  testActor('writer', { permissions: ['exp-note:write', 'exp-note:read'], orgId: tenant }),
];

const Ok = t.object({ ok: t.boolean });
let broken = false;
const refuse = (): never => {
  throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'no such note', fix: 'bind a real id' });
};

const expPassCreate = action({
  input: t.object({ title: t.string.min(1).max(80) }),
  output: Ok,
  policy: can('exp-note:write'),
  async handle({ input, ctx }) {
    await db.notes.insert({ id: crypto.randomUUID(), orgId: ctx.actor.orgId ?? '', ...input });
    return { ok: true };
  },
});
const expPassRead = action({
  input: t.object({ expNoteId: t.uuid }),
  output: Ok,
  policy: can('exp-note:read'),
  async handle({ input }) {
    return (await driver.repo(notes).findById(input.expNoteId)) === null ? refuse() : { ok: true };
  },
});
const expPassThrows = action({
  input: t.object({}),
  output: Ok,
  policy: can('exp-note:write'),
  handle: () => Promise.reject(new TypeError('the handler broke')),
});
const expPassToggle = action({
  input: t.object({}),
  output: Ok,
  policy: can('exp-note:write'),
  handle: () => (broken ? Promise.reject(new TypeError('mutated')) : { ok: true }),
});
const expPassCallsOut = action({
  input: t.object({}),
  output: Ok,
  policy: can('exp-note:write'),
  async handle() {
    // Swallowed on purpose: answering anyway must not read as reached.
    await fetch('https://vendor.example.test/hook').catch(() => undefined);
    return { ok: true };
  },
});
const expPassMagic = action({
  input: t.object({ word: t.string.max(20) }),
  output: Ok,
  policy: can('exp-note:write'),
  handle: ({ input }) => (input.word === 'please' ? { ok: true } : refuse()),
});
const expPassAdmin = action({
  input: t.object({}),
  output: Ok,
  policy: can('exp-admin:do'),
  handle: () => ({ ok: true }),
});
registerActions({
  expPassAdmin,
  expPassCallsOut,
  expPassCreate,
  expPassMagic,
  expPassRead,
  expPassThrows,
  expPassToggle,
});
registerQueries({
  expPassNotes: query({
    input: t.object({}),
    policy: can('exp-note:read'),
    sql: () => from<{ id: string }>('exp_notes', [{ id: 'a' }]).limit(5),
  }),
});
job({
  name: 'expPassJob',
  tenant: (input) => input.expOrgId,
  input: t.object({ expOrgId: t.uuid, expNoteId: t.uuid }),
  idempotencyKey: (input) => input.expNoteId,
  retry: { ...DEFAULT_RETRY, attempts: 1 },
  run: async ({ input }) => {
    if ((await driver.repo(notes).findById(input.expNoteId)) === null) refuse();
  },
});

const one = async (
  only: string,
  overrides?: Parameters<typeof defineExercise>[0],
): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [orgs, notes],
    writer,
    roles,
    only,
    ...(overrides === undefined ? {} : { overrides: defineExercise(overrides) }),
  });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass'), () => {
  test('a handler that answers is reached, and its write is a statement and a row effect', async () => {
    const record = await one('expPassCreate');
    expect(record).toMatchObject({ kind: 'action', outcome: 'reached' });
    expect(record.statements).toBeGreaterThan(0);
    expect(record.effects).toContainEqual({
      kind: 'row',
      entity: 'exp_notes',
      op: 'insert',
      rows: 1,
    });
  });

  test('an id field is bound to a seeded row of the actor tenant', async () => {
    expect((await one('expPassRead')).outcome).toBe('reached');
  });

  test('a handler that throws is unreached, never reached, with the paste-ready override', async () => {
    const record = await one('expPassThrows');
    expect(record.outcome).toBe('unreached');
    expect(record.reason).toContain('TypeError');
    expect(record.override).toStartWith('expPassThrows: { actor: ');
  });

  test('a mutated handler changes the outcome', async () => {
    expect((await one('expPassToggle')).outcome).toBe('reached');
    broken = true;
    try {
      expect((await one('expPassToggle')).outcome).toBe('unreached');
    } finally {
      broken = false;
    }
  });

  test('a call out is refused, counted, and unreached even when the handler swallows it', async () => {
    const record = await one('expPassCallsOut');
    expect(record).toMatchObject({ outcome: 'unreached', code: 'X_TEST_NETWORK_SEALED' });
    expect(record.effects).toContainEqual({
      kind: 'network',
      method: 'GET',
      host: 'vendor.example.test',
      refused: true,
    });
  });

  test('a policy no actor satisfies is refused by design, and nothing runs', async () => {
    const record = await one('expPassAdmin');
    expect(record).toMatchObject({ outcome: 'refused', statements: 0, effects: [] });
    expect(record.reason).toContain('exp-admin:do');
  });

  test('an override wins over the draw', async () => {
    expect(await one('expPassMagic')).toMatchObject({ outcome: 'unreached', code: 'X_NOT_FOUND' });
    const writerActor = testActor('writer', { permissions: ['exp-note:write'] }).actor;
    const record = await one('expPassMagic', {
      expPassMagic: {
        actor: writerActor,
        input: (drawn) => ({ ...drawn, word: 'please' }),
      },
    });
    expect(record.outcome).toBe('reached');
  });

  test('off with a reason is recorded off; a blank reason refuses at declaration', async () => {
    expect(await one('expPassThrows', { expPassThrows: { off: 'calls a bank' } })).toMatchObject({
      outcome: 'off',
      reason: 'calls a bank',
    });
    const blank = (() => {
      try {
        defineExercise({ expPassThrows: { off: '  ' } });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(isUltimateError(blank) && blank.code).toBe('X_CONTRACT_EXERCISE_UNDECLARED');
  });

  test('an unknown override name, or an unknown only, is X_DECLARATION_UNKNOWN', async () => {
    const refused = await runExercisePass({
      entities: [orgs, notes],
      writer,
      roles,
      only: 'expPassCreate',
      overrides: defineExercise({ expPassNoSuch: { off: 'typo' } }),
    }).catch((error: unknown) => error);
    expect(isUltimateError(refused) && refused.code).toBe('X_DECLARATION_UNKNOWN');
    const unknownOnly = await one('expPassNoSuch').catch((error: unknown) => error);
    expect(isUltimateError(unknownOnly) && unknownOnly.code).toBe('X_DECLARATION_UNKNOWN');
  });

  test('a query runs as an allowed reader; a job drains, its id bound to a seeded note', async () => {
    expect(await one('expPassNotes')).toMatchObject({ kind: 'query', outcome: 'reached' });
    expect(await one('expPassJob')).toMatchObject({ kind: 'job', outcome: 'reached' });
  });
});
