// One question, one answer, whichever `AuthAdapter` is asked. `MemoryAdapter` is what `x new`,
// every test in this package and every test in an app runs against; `BuiltinAdapter` is what
// production runs against — and the question these two must never answer differently is "does this
// account exist", because it decides both who may log in and whether a signup collides. Each case
// asserts the memory adapter's BEHAVIOUR and the statement (or the DDL) that has to mean the same
// thing, in one test, so neither side can move alone. Shaped after `jobs/driver-parity.test.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { createRecordingClient } from '@ultimat3/db';
import { BuiltinAdapter } from './builtin-adapter';
import { AuthError } from './errors';
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

/**
 * `x_users.email` is `text not null unique` and `external_id` is `text unique`, so Postgres refuses
 * a second row at either address. `MemoryAdapter` enforced neither — and it is what `x new`
 * scaffolds and what every test in this package and in an app runs against, so the whole
 * `resolveUser`/`createUserFor` duplicate path was only ever exercised against the permissive one.
 *
 * Reproduced before the fix: two `register()` calls at one address created TWO rows, and logging in
 * with the SECOND password answered `X_UNAUTHENTICATED` — `findUserByEmail` returns the first, so
 * the second row was unreachable forever.
 */
describe('a duplicate identity is refused by both, not created by one', () => {
  const SECOND = '00000000-0000-7000-8000-000000000202';

  test('a second row at one email is refused, and the constraint says so in the DDL', async () => {
    const memory = new MemoryAdapter();
    await seed(memory, 'ada@example.com');

    let code = 'did-not-throw';
    try {
      await memory.createUser({
        id: SECOND,
        email: 'ada@example.com',
        passwordHash: 'hash-2',
        orgId: null,
        roles: [],
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
      });
    } catch (error) {
      code = error instanceof AuthError ? error.code : `not-an-AuthError: ${String(error)}`;
    }
    expect(code).toBe('X_AUTH_WRITE_FAILED');
    // The first row is untouched: a refusal that had already written would be worse than the
    // duplicate it refused.
    expect((await memory.findUserById(ID))?.passwordHash).toBe('hash');
    expect(await memory.findUserById(SECOND)).toBeNull();

    expect(X_USERS_TABLE).toContain('email                 text not null unique');
  });

  test('a second row at one external_id is refused too, for the same constraint', async () => {
    const memory = new MemoryAdapter();
    await memory.createUser({
      id: ID,
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      externalId: 'okta|abc',
      createdAt: new Date('2026-08-09T12:00:00.000Z'),
    });

    expect(
      memory.createUser({
        id: SECOND,
        email: 'grace@example.com',
        passwordHash: null,
        orgId: null,
        roles: [],
        externalId: 'okta|abc',
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'X_AUTH_WRITE_FAILED' }));

    expect(X_USERS_TABLE).toContain('external_id           text unique');
  });

  test('the case-sensitivity rule still holds: two spellings are two rows in both', async () => {
    // Uniqueness is over the STORED string, which is `normaliseEmail`'s output at every door.
    // The adapter does not fold case — that would be the divergence the first describe pins.
    const memory = new MemoryAdapter();
    await seed(memory, 'ada@example.com');
    await expect(
      memory.createUser({
        id: SECOND,
        email: 'Ada@Example.COM',
        passwordHash: 'hash-2',
        orgId: null,
        roles: [],
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ id: SECOND });
  });
});

// `external_id text unique` is a Postgres unique index, and a Postgres unique index is NULLS
// DISTINCT: it admits unlimited NULL rows and constrains only the rows that carry a value. The
// memory adapter compared `!== undefined`, so the SECOND account with no external id at all
// collided with the first — and `oauth-login.ts` passes `externalId: grants.externalId ?? null`
// for every first-time OAuth user, which makes the second such signup on a `MemoryAdapter` app
// fail with `X_AUTH_WRITE_FAILED` against a constraint production does not have.
describe('a NULL external id collides with nothing, as NULLS DISTINCT says', () => {
  const SECOND_USER = '00000000-0000-7000-8000-000000000103';

  const oauthUser = (id: string, email: string) => ({
    id,
    email,
    passwordHash: null,
    orgId: null,
    roles: [],
    // Exactly what `oauth-login.ts` binds when the app's `resolveGrants` names no external id.
    externalId: null,
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
  });

  test('two accounts may both hold no external id', async () => {
    const memory = new MemoryAdapter();
    await memory.createUser(oauthUser(ID, 'ada@example.com'));

    await expect(
      memory.createUser(oauthUser(SECOND_USER, 'grace@example.com')),
    ).resolves.toMatchObject({ id: SECOND_USER, externalId: null });
    // Both reachable: a refusal that had stored nothing would still have lost the account.
    expect((await memory.findUserById(ID))?.email).toBe('ada@example.com');
    expect((await memory.findUserById(SECOND_USER))?.email).toBe('grace@example.com');

    // The column is nullable and its uniqueness is the plain index one — no `not null`, so every
    // one of those rows is a row the constraint never compares.
    expect(X_USERS_TABLE).toContain('external_id           text unique');
  });

  test('a VALUE still collides, so the constraint is not simply gone', async () => {
    const memory = new MemoryAdapter();
    await memory.createUser({ ...oauthUser(ID, 'ada@example.com'), externalId: 'okta|abc' });

    await expect(
      memory.createUser({ ...oauthUser(SECOND_USER, 'grace@example.com'), externalId: 'okta|abc' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'X_AUTH_WRITE_FAILED' }));
  });
});

// A consumed link is stamped with the moment it was REDEEMED. `BuiltinAdapter` writes
// `consumed_at = now()`; the memory adapter wrote `new Date(record.createdAt)` — the moment the
// link was ISSUED — so any window measured from that stamp (an audit line, a "was this used
// before it expired" read) answered the wrong instant, and answered it identically for a link
// redeemed a second later and one redeemed a week later.
describe('a redeemed verification is stamped when it is redeemed', () => {
  const ISSUED_AT = new Date('2026-08-09T12:00:00.000Z');
  const REDEEMED_AT = new Date('2026-08-09T12:07:30.000Z');

  const record = {
    id: '00000000-0000-7000-8000-000000000201',
    purpose: 'password-reset',
    identifier: 'ada@example.com',
    tokenHash: 'digest-of-the-token',
    expiresAt: new Date('2026-08-09T13:00:00.000Z'),
    consumedAt: null,
    createdAt: ISSUED_AT,
  };

  test('the memory adapter reads its clock, and Postgres reads the server’s', async () => {
    const memory = new MemoryAdapter(frozenClock(REDEEMED_AT));
    await memory.putVerification(record);

    const taken = await memory.takeVerification(
      record.purpose,
      record.identifier,
      record.tokenHash,
    );

    expect(taken?.consumedAt).toEqual(REDEEMED_AT);
    // The issue time is still the issue time: one of the two moved, not both.
    expect(taken?.createdAt).toEqual(ISSUED_AT);

    const client = createRecordingClient();
    client.on('update x_verifications', { rows: [] });
    await new BuiltinAdapter(client).takeVerification(
      record.purpose,
      record.identifier,
      record.tokenHash,
    );
    expect(client.texts.at(-1)).toContain('set consumed_at = now()');
  });
});
