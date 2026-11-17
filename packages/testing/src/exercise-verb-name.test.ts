// `x g action send-reminder --feature invoice`: an action whose NAME spells no entity, its `id` an
// invoice only by the slice's grant. The pass binds that id and reaches the handler, and the line
// an unreached run prints keeps the entry's declared actor and names no per-run tenant.

import { beforeAll, describe, expect, test } from 'bun:test';
import { action, t } from '@ultimat3/action';
import { registerActions } from '@ultimat3/action/loader';
import { UltimateError, userActor } from '@ultimat3/core';
import { entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import type { NamedActor } from '@ultimat3/policy';
import { can, definePermissions, testActor } from '@ultimat3/policy';
import { defineExercise } from './define-exercise';
import { runExercisePass } from './exercise';
import type { ExerciseRecord } from './exercise-report';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

// In `beforeAll`, as `exercise.test.ts` explains: a module-scope declaration outlives the file.
beforeAll(() => {
  definePermissions(['exv-bill:write']);
});

const orgs = entity('exv_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const bills = entity('exv_bills', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ entity: name, row }) => {
    if (name === orgs.$name) await driver.repo(orgs).insert(row as never);
    else await driver.repo(bills).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};
const roles = (tenant: string): readonly NamedActor[] => [
  testActor('member', { permissions: ['exv-bill:write'], orgId: tenant }),
];

const notFound = (): never => {
  throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'no such bill', fix: 'bind a real id' });
};
/** The generated write's shape: `{ id, orgId }`, the org compared with the actor's. */
const canBillWrite = can<{ readonly orgId: string }>(
  'exv-bill:write',
  ({ actor, input }) => actor !== null && actor.orgId === input.orgId,
);
const Input = t.object({ id: t.uuid, orgId: t.uuid });
const Ok = t.object({ ok: t.boolean });

registerActions({
  exvSendReminder: action({
    input: Input,
    output: Ok,
    policy: canBillWrite,
    async handle({ input }) {
      return (await driver.repo(bills).findById(input.id)) === null ? notFound() : { ok: true };
    },
  }),
  exvAlwaysMissing: action({ input: Input, output: Ok, policy: canBillWrite, handle: notFound }),
});

const ORG = '00000000-0000-4000-8000-000000000002';
const member = userActor({ id: 'member', orgId: ORG, permissions: ['exv-bill:write'] });

const one = async (
  only: string,
  overrides?: Parameters<typeof defineExercise>[0],
): Promise<ExerciseRecord> => {
  const records = await runExercisePass({
    entities: [orgs, bills],
    writer,
    roles,
    only,
    ...(overrides === undefined ? {} : { overrides: defineExercise(overrides) }),
  });
  expect(records).toHaveLength(1);
  return records[0] as ExerciseRecord;
};

describe(testName('unit', 'exercise · a verb name'), () => {
  test('a bare id binds the entity the grant names, so the handler is reached', async () => {
    expect((await one('exvSendReminder')).outcome).toBe('reached');
    const declared = { actor: member, input: (drawn: object) => ({ ...drawn, orgId: ORG }) };
    expect((await one('exvSendReminder', { exvSendReminder: declared })).outcome).toBe('reached');
  });

  test('the paste line keeps the declared actor and is the same every pass', async () => {
    const entry = { exvAlwaysMissing: { actor: member } };
    const [first, second] = [
      await one('exvAlwaysMissing', entry),
      await one('exvAlwaysMissing', entry),
    ];
    expect(first.outcome).toBe('unreached');
    expect(first.override).toBe(second.override);
    expect(first.override).toBe(
      `exvAlwaysMissing: { actor: userActor({ id: "member", orgId: "${ORG}", permissions: ["exv-bill:write"] }), input: (drawn) => ({ ...drawn, orgId: "${ORG}" }) }, // userActor: @ultimat3/core`,
    );
  });

  test('with the pass picking the actor, the tenant is left to the pass: no literal, no hole', async () => {
    const record = await one('exvAlwaysMissing');
    expect(record.override).toBe(
      'exvAlwaysMissing: { actor: testActor("member", { permissions: ["exv-bill:write"] }).actor, input: (drawn) => ({ ...drawn }) }, // testActor: @ultimat3/policy',
    );
  });
});
