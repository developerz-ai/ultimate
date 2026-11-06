// `auditSubjectTarget` against `x_audit` on PGlite: the export pages the subject's trail by id;
// the erase overwrites who acted and what they sent, in bounded batches, and keeps the row — the
// record of what happened outlives the person it was about.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import { SQL_AUDIT_TABLE } from './audit-postgres';
import { auditSubjectTarget } from './audit-subject-target';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();
const executor: PgExecutor = {
  query: (text, values) => client.query({ text, values: [...values] }),
};
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  for (const statement of SQL_AUDIT_TABLE.split(';')) {
    if (statement.trim() !== '') await client.execute(raw(statement));
  }
  const rows: [number, string, string | null][] = [
    [1, 'me', null],
    [2, 'me', null],
    [3, 'agent', 'me'],
    [4, 'you', null],
  ];
  for (const [n, actor, behalf] of rows) {
    await executor.query(
      `insert into x_audit (id, at, action, mutator, surface, outcome, replayed, actor_id,
        actor_kind, on_behalf_of_id, request_id, trace_id, locale, tz, build_id, role, input)
       values ($1, now(), 'publish', false, 'http', 'ok', false, $2, 'user', $3, 'r', 't', 'en',
        'UTC', 'b', 'web', '{"email":"me@x.test"}')`,
      [id(n), actor, behalf],
    );
  }
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

const target = auditSubjectTarget({ executor });
const ref = { key: 'me', row: {} };

describe('auditSubjectTarget', () => {
  test('pages the trail the subject acted in, by id, and stops on a short page', async () => {
    const first = await target.exportPage(ref, null, 2);
    expect(first.rows.map((row) => row['id'])).toEqual([id(1), id(2)]);
    const second = await target.exportPage(ref, first.cursor, 2);
    expect(second.rows.map((row) => row['id'])).toEqual([id(3)]);
    expect(second.cursor).toBeNull();
  });

  test('the erase rewrites the actor and the input, keeps every row, and only the subject', async () => {
    expect(await target.erase(ref, 2)).toBe(2);
    expect(await target.erase(ref, 2)).toBe(1);
    expect(await target.erase(ref, 2)).toBe(0);
    const left = await client.query<{
      actor_id: string;
      on_behalf_of_id: string | null;
      input: unknown;
    }>(raw('select actor_id, on_behalf_of_id, input from x_audit order by id'));
    expect(left.map((row) => [row.actor_id, row.on_behalf_of_id])).toEqual([
      ['erased', null],
      ['erased', null],
      ['agent', 'erased'],
      ['you', null],
    ]);
    expect(left.slice(0, 3).every((row) => row.input === null)).toBe(true);
    expect(left[3]?.input).not.toBeNull();
  });
});
