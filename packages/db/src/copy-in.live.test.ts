// `copyIn` against a real Postgres: the server reads every cell kind the unit test spells the way a
// bound parameter would have stored it, a refused row stores nothing, and a copy on a pin belongs to
// that pin's transaction. Live-only — the text format is the server's to judge, not a double's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { identifier, raw, sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'copy_in_live';
const target = sql`copy ${identifier(TABLE)} ("id", "name", "doc", "at", "bytes", "tags", "flag") from stdin`;

interface Stored {
  readonly id: number;
  readonly name: string | null;
  readonly doc: unknown;
  readonly at: Date | null;
  readonly bytes: Uint8Array | null;
  readonly tags: readonly (string | null)[] | null;
  readonly flag: boolean | null;
}

describe.skipIf(!hasPostgres)('live · postgres · copyIn', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 2 } });
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await client.execute(
      raw(
        `create table "${TABLE}" (id integer primary key, name text, doc jsonb, at timestamptz, bytes bytea, tags text[], flag boolean)`,
      ),
    );
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await client.close();
  });

  test('every cell kind lands as the value a parameter would have stored', async () => {
    const at = new Date('2026-03-04T05:06:07.890Z');
    const count = await client.copyIn(target, [
      [
        1,
        'tab\there\nnewline \\ back',
        '{"a":[1,"\\t"]}',
        at,
        new Uint8Array([0, 92, 255]),
        '{"x,y","z\\\\"}',
        true,
      ],
      [2, null, 'null', null, null, null, false],
      [3, 'NULL', null, null, null, ['a b', null], null],
    ]);
    expect(count).toBe(3);
    const rows = await client.query<Stored>(sql`select * from ${identifier(TABLE)} order by id`);
    expect(rows[0]?.name).toBe('tab\there\nnewline \\ back');
    expect(rows[0]?.doc).toEqual({ a: [1, '\t'] });
    expect(rows[0]?.at?.toISOString()).toBe(at.toISOString());
    expect([...(rows[0]?.bytes ?? [])]).toEqual([0, 92, 255]);
    expect(rows[0]?.tags).toEqual(['x,y', 'z\\']);
    expect(rows[0]?.flag).toBe(true);
    // The JSON literal `null` is a jsonb value; `\N` is SQL NULL — two different stored things.
    expect(rows[1]?.doc).toBeNull();
    const kinds = await client.query<{ kind: string | null }>(
      sql`select jsonb_typeof(doc) as kind from ${identifier(TABLE)} where id = ${2}`,
    );
    expect(kinds[0]?.kind).toBe('null');
    expect(rows[2]?.name).toBe('NULL');
    expect(rows[2]?.tags).toEqual(['a b', null]);
  });

  test('a duplicate key refuses the whole copy, typed, and the pool still answers', async () => {
    try {
      await client.copyIn(target, [
        [10, 'new', null, null, null, null, null],
        [1, 'dup', null, null, null, null, null],
      ]);
      expect.unreachable('row 1 is already stored');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_DB_UNIQUE_VIOLATION');
    }
    const left = await client.query<{ n: number }>(
      sql`select count(*)::int as n from ${identifier(TABLE)} where id = ${10}`,
    );
    expect(left[0]?.n).toBe(0);
  });

  test("a throw from the caller's rows leaves the pin alive: coded X_INVARIANT, the next statement runs", async () => {
    const pin = await client.reserve();
    const failure = new RangeError('the source failed');
    try {
      function* rows(): Generator<readonly unknown[]> {
        yield [30, 'first', null, null, null, null, null];
        throw failure;
      }
      const failed = await pin.copyIn(target, rows()).catch((error: unknown) => error);
      expect(isUltimateError(failed) && failed.code).toBe('X_INVARIANT');
      expect((failed as { sourceError?: unknown }).sourceError).toBe(failure);
      const after = await pin.query<{ n: number }>(
        sql`select count(*)::int as n from ${identifier(TABLE)} where id = ${30}`,
      );
      expect(after[0]?.n).toBe(0);
    } finally {
      pin.release();
    }
  });

  test('a copy on a pin is that transaction’s: rolled back, nothing stays', async () => {
    const pin = await client.reserve();
    try {
      await pin.execute(raw('begin'));
      expect(await pin.copyIn(target, [[20, 'pinned', null, null, null, null, null]])).toBe(1);
      const inside = await pin.query<{ n: number }>(
        sql`select count(*)::int as n from ${identifier(TABLE)} where id = ${20}`,
      );
      expect(inside[0]?.n).toBe(1);
      await pin.execute(raw('rollback'));
    } finally {
      pin.release();
    }
    const after = await client.query<{ n: number }>(
      sql`select count(*)::int as n from ${identifier(TABLE)} where id = ${20}`,
    );
    expect(after[0]?.n).toBe(0);
  });

  test('a generated row stream copies without being held in an array', async () => {
    function* rows(): Generator<readonly unknown[]> {
      for (let id = 1000; id < 6000; id += 1) yield [id, `r${id}`, null, null, null, null, null];
    }
    expect(await client.copyIn(target, rows())).toBe(5000);
  });
});
