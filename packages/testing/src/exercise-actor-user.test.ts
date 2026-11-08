// An app on `@ultimat3/auth` reads `ctx.actor.id` as an `x_users` uuid, as it always is in
// production. The repro: a role-gated action whose handler looks its caller up through the
// framework's own adapter. With role names as ids it was a 500 (`22P02 invalid input syntax for
// type uuid: "owner"`); with a uuid and no row, `X_NOT_FOUND`. The pass seats the user it acts as.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { AUTH_TABLES, postgresAuthAdapter } from '@ultimat3/auth';
import { UltimateError, useContext } from '@ultimat3/core';
import type { PgliteClient } from '@ultimat3/db';
import { pgliteClient, raw, setDbClient } from '@ultimat3/db';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { can, definePermissions, defineRoles, testActor } from '@ultimat3/policy';
import { runExercisePass } from './exercise';
import { exerciseActorId } from './exercise-actor';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const orgs = entity('eau_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(orgs).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

let client: PgliteClient;
beforeAll(async () => {
  client = pgliteClient();
  // One statement at a time, as cli's `applyFrameworkSchema` applies them on every boot.
  const statements = AUTH_TABLES.flatMap((ddl) => ddl.split(';')).filter((s) => s.trim() !== '');
  for (const statement of statements) await client.execute(raw(statement));
  setDbClient(client);
});
afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

definePermissions(['eau:read']);
defineRoles({ eauOwner: { grants: ['eau:read'] } });
const adapter = postgresAuthAdapter();

const eauWhoAmI = action({
  input: t.object({ note: t.string.max(20) }),
  output: t.object({ email: t.string }),
  // Granted through the role only: the actor holds no permission of its own.
  policy: can('eau:read'),
  handle: async () => {
    const user = await adapter.findUserById(useContext().actor.id);
    if (user === null) {
      throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'no such user', fix: 'seed it' });
    }
    return { email: user.email };
  },
});
registerActions({ eauWhoAmI });

const roles = (tenant: string) => [
  { name: 'anonymous', actor: null },
  testActor('eauOwner', { roles: ['eauOwner'], orgId: tenant }),
];

describe(testName('unit', 'the exercise actor is a user'), () => {
  test('a role-gated handler reading its caller through the auth adapter is reached', async () => {
    const records = await runExercisePass({
      entities: [orgs],
      writer,
      roles,
      only: 'eauWhoAmI',
      seed: 7,
    });
    expect(records[0]).toMatchObject({ name: 'eauWhoAmI', outcome: 'reached' });
  });

  test('an actor id is a uuid, the same for one role in one tenant, different across either', () => {
    const a = exerciseActorId('owner', 'tenant-a');
    expect(a).toMatch(UUID);
    expect(exerciseActorId('owner', 'tenant-a')).toBe(a);
    expect(exerciseActorId('owner', 'tenant-b')).not.toBe(a);
    expect(exerciseActorId('member', 'tenant-a')).not.toBe(a);
  });
});
