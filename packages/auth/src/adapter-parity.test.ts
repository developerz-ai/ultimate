// One question, one answer, whichever `AuthAdapter` is asked. `MemoryAdapter` is what `x new`,
// every test in this package and every test in an app runs against; `BuiltinAdapter` is what
// production runs against — and the question these two must never answer differently is "does this
// account exist", because it decides both who may log in and whether a signup collides. Each case
// asserts the memory adapter's BEHAVIOUR and the statement (or the DDL) that has to mean the same
// thing, in one test, so neither side can move alone. Shaped after `jobs/driver-parity.test.ts`.

import { describe, expect, test } from 'bun:test';
import { createRecordingClient } from '@ultimat3/db';
import { BuiltinAdapter } from './builtin-adapter';
import { MemoryAdapter } from './memory-adapter';
import { X_USERS_TABLE } from './tables';

const ID = '00000000-0000-7000-8000-000000000101';

const seed = async (adapter: MemoryAdapter, email: string): Promise<void> => {
  await adapter.createUser({
    id: ID,
    email,
    passwordHash: 'hash',
    orgId: null,
    roles: [],
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
  });
};

describe('an address is looked up exactly as it is stored', () => {
  test('neither adapter folds case on the way in or on the way out', async () => {
    const memory = new MemoryAdapter();
    await seed(memory, 'ada@example.com');
    expect((await memory.findUserByEmail('ada@example.com'))?.id).toBe(ID);
    // The divergence this pins: the memory adapter lowercased both the stored address and the
    // argument, so it answered "yes, that account exists" where Postgres answers "no". On the
    // OAuth path — `resolveUser` in `oauth-login.ts` — that is link-an-existing-account under
    // `x dev` and create-a-second-one in production, off one provider that changed its casing.
    expect(await memory.findUserByEmail('Ada@Example.COM')).toBeNull();

    const client = createRecordingClient();
    await new BuiltinAdapter(client).findUserByEmail('Ada@Example.COM');
    expect(client.texts.at(-1)).toContain('where email = $1');
    // Bound verbatim, against a column whose uniqueness is the plain `text` one. No `citext` and
    // no `lower(email)` index, so `=` is case-sensitive and this is the whole of the pg answer.
    expect(client.statements.at(-1)?.values).toEqual(['Ada@Example.COM']);
    expect(X_USERS_TABLE).toContain('email                 text not null unique');
  });

  test('createUser stores the address it was handed, in both', async () => {
    const memory = new MemoryAdapter();
    await seed(memory, ' Ada@Example.COM ');
    // An adapter that normalises is an adapter that hides a caller which forgot to. Normalisation
    // belongs at the ONE boundary an address enters through (`normaliseEmail`), above the seam, or
    // the two implementations of that seam get to disagree about what they stored.
    expect((await memory.findUserById(ID))?.email).toBe(' Ada@Example.COM ');

    const client = createRecordingClient();
    client.on('insert into x_users', { rows: [] });
    await new BuiltinAdapter(client)
      .createUser({
        id: ID,
        email: ' Ada@Example.COM ',
        passwordHash: 'hash',
        orgId: null,
        roles: [],
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
      })
      .catch(() => undefined);
    expect(client.statements.at(-1)?.values?.[1]).toBe(' Ada@Example.COM ');
  });
});
