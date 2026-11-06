// `authSubjectTarget()`: the identity tables this package owns, as a subject target a
// `defineSubject({ targets })` lists — structural, so `@ultimat3/jobs` imports nothing from here.
// Exports the `x_users` row (never a digest or the sealed TOTP seed); erases the user, which
// cascades their sessions and linked accounts, plus their API keys and pending verifications.

import type { PgExecutor } from '@ultimat3/core';

/** The subject as a target is handed it: the key asked for, and the subject's row read fresh. */
export interface AuthSubjectRef {
  readonly key: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface AuthSubjectTargetOptions {
  readonly executor: PgExecutor;
  /**
   * The `x_users.id` the subject is: `({ row }) => String(row.userId)` for a membership row that
   * carries it. `undefined` is a subject with no identity here, and touches nothing.
   */
  readonly user: (subject: AuthSubjectRef) => string | undefined;
}

type Cell = string | number | boolean | null;

export interface AuthSubjectTarget {
  readonly name: 'x_users';
  readonly columns: readonly string[];
  exportPage(
    subject: AuthSubjectRef,
    cursor: string | null,
    size: number,
  ): Promise<{ readonly rows: readonly Readonly<Record<string, Cell>>[]; readonly cursor: null }>;
  erase(subject: AuthSubjectRef, size: number): Promise<number>;
}

/** What leaves in an export. `password_hash`, `mfa_secret` and the recovery digests never do. */
export const AUTH_SUBJECT_COLUMNS = [
  'id',
  'email',
  'email_verified_at',
  'roles',
  'created_at',
] as const;

const SQL_USER = `select id::text as id, email, email_verified_at::text as email_verified_at,
  array_to_string(roles, ',') as roles, created_at::text as created_at
  from x_users where id = $1::uuid`;
const SQL_API_KEYS = 'delete from x_api_keys where user_id = $1::uuid';
const SQL_VERIFICATIONS = `delete from x_verifications
  where identifier = (select email from x_users where id = $1::uuid)`;
// Sessions and accounts reference the user `on delete cascade` (`tables.ts`): one statement.
const SQL_USER_DELETE = 'delete from x_users where id = $1::uuid returning id';

export function authSubjectTarget(options: AuthSubjectTargetOptions): AuthSubjectTarget {
  const { executor } = options;
  return {
    name: 'x_users',
    columns: AUTH_SUBJECT_COLUMNS,
    async exportPage(subject) {
      const id = options.user(subject);
      if (id === undefined) return { rows: [], cursor: null };
      const rows = await executor.query<Record<string, Cell>>(SQL_USER, [id]);
      return { rows, cursor: null };
    },
    async erase(subject) {
      const id = options.user(subject);
      if (id === undefined) return 0;
      await executor.query(SQL_API_KEYS, [id]);
      await executor.query(SQL_VERIFICATIONS, [id]);
      return (await executor.query(SQL_USER_DELETE, [id])).length;
    },
  };
}
