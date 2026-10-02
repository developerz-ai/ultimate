// A refused identity write answers ONE code on both adapters, and a redemption is stamped from one
// clock on both. The Postgres half runs on PGlite — a real server's 23505, its real constraint
// names — because a scripted client can only prove the adapter reads the shape the test invented.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import {
  createPgliteClient,
  type DbClient,
  driverError,
  raw,
  type SqlFragment,
} from '@ultimat3/db';
import type { AuthAdapter, CreateUserInput } from './adapter';
import { BuiltinAdapter } from './builtin-adapter';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const REDEEMED_AT = new Date('2031-03-04T05:06:07.000Z');
const clock = frozenClock(REDEEMED_AT);
const client = createPgliteClient();

const ADA = '00000000-0000-7000-8000-000000000301';
const GRACE = '00000000-0000-7000-8000-000000000302';
const LINUS = '00000000-0000-7000-8000-000000000303';

const user = (id: string, email: string, externalId?: string | null): CreateUserInput => ({
  id,
  email,
  passwordHash: null,
  orgId: null,
  roles: [],
  externalId,
  createdAt: new Date('2026-08-09T12:00:00.000Z'),
});

beforeAll(async () => {
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

/** What a refused write answered: the code and the two `meta` fields a caller may branch on. */
const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (!(error instanceof AuthError)) return `not-an-AuthError: ${String(error)}`;
    return `${error.code} ${String(error.meta?.['operation'])} ${String(error.meta?.['column'])}`;
  }
  return 'did-not-throw';
};

const ADAPTERS: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAdapter', async () => new MemoryAdapter(clock)],
  [
    'BuiltinAdapter on PGlite',
    async () => {
      await client.execute(raw('delete from x_verifications'));
      await client.execute(raw('delete from x_users'));
      return new BuiltinAdapter(client, clock);
    },
  ],
];

describe.each(ADAPTERS)('%s refuses a duplicate identity as X_AUTH_WRITE_FAILED', (_name, make) => {
  test('createUser: a second row at one email', async () => {
    const adapter = await make();
    await adapter.createUser(user(ADA, 'ada@example.com'));
    expect(await refusal(adapter.createUser(user(GRACE, 'ada@example.com')))).toBe(
      'X_AUTH_WRITE_FAILED createUser email',
    );
    expect(await adapter.findUserById(GRACE)).toBeNull();
  });

  test('createUser: a second row at one external_id, and NULLs never collide', async () => {
    const adapter = await make();
    await adapter.createUser(user(ADA, 'ada@example.com', 'okta|abc'));
    expect(await refusal(adapter.createUser(user(GRACE, 'grace@example.com', 'okta|abc')))).toBe(
      'X_AUTH_WRITE_FAILED createUser external_id',
    );
    await adapter.createUser(user(GRACE, 'grace@example.com', null));
    await adapter.createUser(user(LINUS, 'linus@example.com', null));
    expect((await adapter.findUserById(LINUS))?.externalId).toBeNull();
  });

  test('createUser: a second row at one id leaves the first as it was', async () => {
    const adapter = await make();
    await adapter.createUser(user(ADA, 'ada@example.com'));
    expect(await refusal(adapter.createUser(user(ADA, 'grace@example.com')))).toBe(
      'X_AUTH_WRITE_FAILED createUser id',
    );
    expect((await adapter.findUserById(ADA))?.email).toBe('ada@example.com');
  });

  test('updateUser: an external_id another row holds, and the row keeps its own', async () => {
    const adapter = await make();
    await adapter.createUser(user(ADA, 'ada@example.com', 'okta|abc'));
    await adapter.createUser(user(GRACE, 'grace@example.com', 'okta|def'));
    expect(await refusal(adapter.updateUser(GRACE, { externalId: 'okta|abc' }))).toBe(
      'X_AUTH_WRITE_FAILED updateUser external_id',
    );
    expect((await adapter.findUserById(GRACE))?.externalId).toBe('okta|def');
  });

  test('updateUser: a row may be handed its own external_id, and two may clear theirs', async () => {
    const adapter = await make();
    await adapter.createUser(user(ADA, 'ada@example.com', 'okta|abc'));
    await adapter.createUser(user(GRACE, 'grace@example.com', 'okta|def'));
    expect((await adapter.updateUser(ADA, { externalId: 'okta|abc' }))?.externalId).toBe(
      'okta|abc',
    );
    expect((await adapter.updateUser(ADA, { externalId: null }))?.externalId).toBeNull();
    expect((await adapter.updateUser(GRACE, { externalId: null }))?.externalId).toBeNull();
  });

  test('takeVerification stamps consumedAt from the adapter’s clock', async () => {
    const adapter = await make();
    await adapter.putVerification({
      id: '00000000-0000-7000-8000-000000000311',
      purpose: 'password-reset',
      identifier: 'ada@example.com',
      tokenHash: 'digest',
      expiresAt: new Date('2031-03-04T06:00:00.000Z'),
      consumedAt: null,
      createdAt: new Date('2031-03-04T05:00:00.000Z'),
    });
    const taken = await adapter.takeVerification('password-reset', 'ada@example.com', 'digest');
    // A year the server's `now()` and the process's `Date.now()` cannot answer.
    expect(taken?.consumedAt).toEqual(REDEEMED_AT);
    expect(
      await adapter.takeVerification('password-reset', 'ada@example.com', 'digest'),
    ).toBeNull();
  });
});

/** A `DbClient` whose every statement fails with `failure` — the driver's throw, or db's wrap. */
const failingWith = (failure: (fragment: SqlFragment) => unknown): DbClient => ({
  query: async (fragment) => Promise.reject(failure(fragment)),
  one: async (fragment) => Promise.reject(failure(fragment)),
  execute: async (fragment) => Promise.reject(failure(fragment)),
});

/** Bun.SQL's ErrorResponse, as measured: the state on `errno`, `severity` present. */
const bunSqlError = (errno: string, constraint: string | undefined): unknown =>
  Object.assign(Object.create(Error.prototype) as object, {
    message: `duplicate key value violates unique constraint "${String(constraint)}"`,
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno,
    severity: 'ERROR',
    ...(constraint === undefined ? {} : { constraint }),
  });

describe('BuiltinAdapter reads the violation off the driver error, wrapped or not', () => {
  test.each([
    ['x_users_email_key', 'email'],
    ['x_users_external_id_key', 'external_id'],
    ['x_users_pkey', 'id'],
  ])('%s as Bun.SQL throws it, bare and inside db’s DbError', async (constraint, column) => {
    const bare = new BuiltinAdapter(failingWith(() => bunSqlError('23505', constraint)));
    expect(await refusal(bare.createUser(user(ADA, 'ada@example.com')))).toBe(
      `X_AUTH_WRITE_FAILED createUser ${column}`,
    );
    const wrapped = new BuiltinAdapter(
      failingWith((fragment) => driverError(fragment.text, bunSqlError('23505', constraint))),
    );
    expect(await refusal(wrapped.updateUser(ADA, { externalId: 'okta|abc' }))).toBe(
      `X_AUTH_WRITE_FAILED updateUser ${column}`,
    );
  });

  test('a constraint x_users does not declare is not renamed to one it does', async () => {
    const failure = driverError('insert', bunSqlError('23505', 'app_users_handle_key'));
    const adapter = new BuiltinAdapter(failingWith(() => failure));
    expect(adapter.createUser(user(ADA, 'ada@example.com'))).rejects.toBe(failure);
  });

  test('another SQLSTATE travels on untouched', async () => {
    const failure = driverError('insert', bunSqlError('23503', 'x_users_email_key'));
    const adapter = new BuiltinAdapter(failingWith(() => failure));
    expect(adapter.createUser(user(ADA, 'ada@example.com'))).rejects.toBe(failure);
    expect(adapter.updateUser(ADA, { externalId: 'okta|abc' })).rejects.toBe(failure);
  });
});
