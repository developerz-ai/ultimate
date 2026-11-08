// `x exercise` over an action that finishes a cookie-held step: unreached with no `request` in its
// entry, reached with one — a declared value, or a function minting the cookie for each actor.

import { describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { UltimateError } from '@ultimat3/core';
import { entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { useRequestCookie } from '@ultimat3/http';
import type { NamedActor } from '@ultimat3/policy';
import { allow } from '@ultimat3/policy';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const orgs = entity('exrp_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(orgs).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};
const roles = (): readonly NamedActor[] => [{ name: 'anonymous', actor: null }];

const exrpFinishSignIn = action({
  input: t.object({ code: t.string.min(1).max(12) }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  async handle() {
    if (useRequestCookie('exrp_pending') === null) {
      throw new UltimateError({
        code: 'X_NOT_FOUND',
        cause: 'no pending sign-in on this request',
        fix: 'start the sign-in first',
      });
    }
    return { ok: true };
  },
});
registerActions({ exrpFinishSignIn });

const pass = async (overrides: Parameters<typeof defineExercise>[0]): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [orgs],
    writer,
    roles,
    only: 'exrpFinishSignIn',
    overrides: defineExercise(overrides),
  });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'runExercisePass and an entry request'), () => {
  test('no request: the cookie-held step is unreached', async () => {
    const record = await pass({});
    expect(record).toMatchObject({ kind: 'action', outcome: 'unreached', code: 'X_NOT_FOUND' });
  });

  test("a declared request's cookie reaches it", async () => {
    const record = await pass({
      exrpFinishSignIn: { request: { cookies: { exrp_pending: 'p' } } },
    });
    expect(record).toMatchObject({ kind: 'action', outcome: 'reached' });
  });

  test('a function request, minted for each call, reaches it', async () => {
    const minted: (string | null)[] = [];
    const record = await pass({
      exrpFinishSignIn: {
        request: async (actor) => {
          minted.push(actor === null ? null : actor.id);
          return { cookies: { exrp_pending: 'minted' } };
        },
      },
    });
    expect(record).toMatchObject({ kind: 'action', outcome: 'reached' });
    expect(minted.length).toBeGreaterThan(0);
  });
});
