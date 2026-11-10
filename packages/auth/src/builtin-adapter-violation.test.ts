// `PostgresAuthAdapter` reads a unique violation off the driver's error, bare or inside db's
// `DbError`, and renames only the constraints `x_users` declares. What an adapter answers for a
// duplicate is `@ultimat3/testing`'s `authAdapterConformance`; this is the mapping beneath it.

import { describe, expect, test } from 'bun:test';
import { type DbClient, driverError, type SqlFragment } from '@ultimat3/db';
import type { CreateUserInput } from './adapter';
import { postgresAuthAdapter } from './builtin-adapter';
import { AuthError } from './errors';

const ADA = '00000000-0000-7000-8000-000000000301';

const user: CreateUserInput = {
  id: ADA,
  email: 'ada@example.com',
  passwordHash: null,
  orgId: null,
  roles: [],
  createdAt: new Date('2026-08-09T12:00:00.000Z'),
};

/** What a refused write answered: the code and the two `meta` fields a caller may branch on. */
const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (!(error instanceof AuthError)) return `not-an-AuthError: ${typeof error}`;
    return `${error.code} ${String(error.meta?.['operation'])} ${String(error.meta?.['column'])}`;
  }
  return 'did-not-throw';
};

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

describe('PostgresAuthAdapter reads the violation off the driver error, wrapped or not', () => {
  test.each([
    ['x_users_email_key', 'email'],
    ['x_users_external_id_key', 'external_id'],
    ['x_users_pkey', 'id'],
  ])('%s as Bun.SQL throws it, bare and inside db’s DbError', async (constraint, column) => {
    const bare = postgresAuthAdapter(failingWith(() => bunSqlError('23505', constraint)));
    expect(await refusal(bare.createUser(user))).toBe(`X_AUTH_WRITE_FAILED createUser ${column}`);
    const wrapped = postgresAuthAdapter(
      failingWith((fragment) => driverError(fragment.text, bunSqlError('23505', constraint))),
    );
    expect(await refusal(wrapped.updateUser(ADA, { externalId: 'okta|abc' }))).toBe(
      `X_AUTH_WRITE_FAILED updateUser ${column}`,
    );
  });

  test('a constraint x_users does not declare is not renamed to one it does', async () => {
    const failure = driverError('insert', bunSqlError('23505', 'app_users_handle_key'));
    const adapter = postgresAuthAdapter(failingWith(() => failure));
    await expect(adapter.createUser(user)).rejects.toBe(failure);
  });

  test('another SQLSTATE travels on untouched', async () => {
    const failure = driverError('insert', bunSqlError('23503', 'x_users_email_key'));
    const adapter = postgresAuthAdapter(failingWith(() => failure));
    await expect(adapter.createUser(user)).rejects.toBe(failure);
    await expect(adapter.updateUser(ADA, { externalId: 'okta|abc' })).rejects.toBe(failure);
  });
});
