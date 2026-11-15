// `authSubjectTarget` against the real auth schema on PGlite: the export carries the user row and
// no digest; the erase removes the user — sessions and accounts by cascade — their API keys and
// verifications, and touches nobody else.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import { authSubjectTarget } from './subject-target';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();
const executor: PgExecutor = {
  query: (text, values) => client.query({ text, values: [...values] }),
};
const ME = '00000000-0000-7000-8000-000000000a01';
const YOU = '00000000-0000-7000-8000-000000000a02';

const count = async (sql: string): Promise<number> =>
  Number((await client.query<{ n: number | string }>(raw(sql)))[0]?.n ?? 0);

beforeAll(async () => {
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
  for (const [id, email] of [
    [ME, 'me@x.test'],
    [YOU, 'you@x.test'],
  ] as const) {
    await executor.query(
      `insert into x_users (id, email, password_hash, mfa_secret) values ($1, $2, 'argon', 'x1.k')`,
      [id, email],
    );
    await executor.query(
      `insert into x_sessions (id, user_id, token_hash, absolute_expires_at) values ($1, $2, 'h', now())`,
      [`s-${email}`, id],
    );
    await executor.query(
      `insert into x_verifications (id, purpose, identifier, token_hash, expires_at) values ($1, 'verify', $2, 'h', now())`,
      [`v-${email}`, email],
    );
  }
  // An invite's key carries the address last; a lookalike that only a `like` wildcard would match
  // (`m_` against `me`) belongs to somebody else and stays.
  for (const [id, identifier] of [
    ['i-me', JSON.stringify(['00000000-0000-7000-8000-0000000000aa', 'me@x.test'])],
    ['i-lookalike', JSON.stringify(['00000000-0000-7000-8000-0000000000aa', 'm_@x.test'])],
  ] as const) {
    await executor.query(
      `insert into x_verifications (id, purpose, identifier, token_hash, expires_at) values ($1, 'member-invite', $2, 'h', now())`,
      [id, identifier],
    );
  }
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

const target = authSubjectTarget({ executor, user: ({ row }) => String(row['userId']) });
const ref = { key: 'member-1', row: { userId: ME } };

describe('authSubjectTarget', () => {
  test('exports the user row and never a digest or the sealed seed', async () => {
    const page = await target.exportPage(ref, null, 10);
    expect(page.rows.map((row) => row['email'])).toEqual(['me@x.test']);
    expect(Object.keys(page.rows[0] ?? {}).sort()).toEqual([...target.columns].sort());
    expect(JSON.stringify(page.rows)).not.toContain('argon');
    expect(JSON.stringify(page.rows)).not.toContain('x1.k');
  });

  test('erases the user, their sessions, verifications and invites, and nobody else', async () => {
    expect(await target.erase(ref, 10)).toBe(1);
    expect(await count(`select count(*) as n from x_users where id = '${ME}'`)).toBe(0);
    expect(await count(`select count(*) as n from x_sessions where user_id = '${ME}'`)).toBe(0);
    expect(
      await count(`select count(*) as n from x_verifications where identifier = 'me@x.test'`),
    ).toBe(0);
    expect(await count('select count(*) as n from x_users')).toBe(1);
    expect(await count(`select count(*) as n from x_verifications where id = 'i-me'`)).toBe(0);
    expect(await count(`select count(*) as n from x_verifications where id = 'i-lookalike'`)).toBe(
      1,
    );
    expect(await count('select count(*) as n from x_verifications')).toBe(2);
    // A replay finds nothing left: the batch loop ends on a short answer.
    expect(await target.erase(ref, 10)).toBe(0);
  });

  test('a subject with no identity touches nothing', async () => {
    const none = authSubjectTarget({ executor, user: () => undefined });
    expect(await none.erase(ref, 10)).toBe(0);
    expect((await none.exportPage(ref, null, 10)).rows).toEqual([]);
  });
});
