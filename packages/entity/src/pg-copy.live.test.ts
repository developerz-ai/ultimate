// `insertAll(rows, { returning: false })`, `upsertAll(…, { returning: false })` and `copyAll`
// against a real Postgres, through the typed handle an app calls. The claims: a count and nothing
// else comes back, a copied row is byte-for-byte the row `insertAll` stores from the same input —
// every awkward cell kind included — and COPY is one all-or-nothing statement past the bind ceiling.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError, subscribe } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { boolean, integer, money, newId, text, timestamp, uuid } from './columns';
import { arrayOf, json } from './columns-data';
import { database } from './database';
import { entity } from './entity';
import { MAX_ROWS_PER_COPY } from './pg-copy';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

// Unconditional and top-level: a skipped suite still registered its entities on import.
afterAll(() => {
  clearRegistry();
});

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

/** Every cell kind COPY's text format has to spell the way a bound parameter would. */
const loads = entity('pg_copy_live_loads', {
  columns: {
    id: uuid().primaryKey(),
    batch: text({ max: 20 }),
    seq: integer(),
    label: text().nullable(),
    flag: boolean().default(false),
    total: money(),
    doc: json(t.object({ note: t.string })).nullable(),
    tags: arrayOf(text({ max: 40 })).nullable(),
    at: timestamp().nullable(),
    stampedAt: timestamp().defaultNow(),
  },
  indexes: [{ on: ['batch', 'seq'], unique: true }],
});

const DROP = 'drop table if exists "pg_copy_live_loads" cascade';

type Load = typeof loads.$row;

const AWKWARD = 'tab\there, newline\nthere, back\\slash, \\N, NULL';

const row = (batch: string, seq: number) => ({
  batch,
  seq,
  label: seq % 2 === 0 ? AWKWARD : null,
  total: { minor: 12_345 + seq, currency: 'EUR' },
  doc: seq % 3 === 0 ? null : { note: `line\n${seq}\t"q"` },
  tags: seq % 2 === 0 ? ['a,b', 'c"d', 'e\\f', ''] : null,
  at: new Date(Date.UTC(2026, 10, 11, 12, 0, 0, seq)),
});

/** Everything but what each call mints for itself: its id, its batch and its default stamp. */
const content = (stored: readonly Load[]) =>
  [...stored]
    .sort((left, right) => left.seq - right.seq)
    .map(({ id: _id, batch: _batch, stampedAt: _stamp, ...rest }) => rest);

describe.skipIf(!hasPostgres)('live · postgres · count-only writes and copyAll', () => {
  let client: PostgresClient;
  const db = () => database({ loads }, { driver: postgresDriver() });
  const stored = (batch: string) => db().loads.where({ batch }).limit(1000).all();

  /** The texts of every statement sent against the table while `work` runs. */
  const sent = async <T>(work: () => Promise<T>): Promise<[T, string[]]> => {
    const texts: string[] = [];
    const off = subscribe('db.statement', ({ payload }) => {
      if (payload.text.includes('pg_copy_live_loads')) texts.push(payload.text);
    });
    try {
      return [await work(), texts];
    } finally {
      off();
    }
  };

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [loads.$describe()],
      name: 'live copy',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  test('insertAll returning:false answers the count, sends no returning, stores the rows', async () => {
    const [count, texts] = await sent(() =>
      db().loads.insertAll([row('ins', 1), row('ins', 2)], { returning: false }),
    );
    expect(count).toBe(2);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain('returning');
    expect(await stored('ins')).toHaveLength(2);
  });

  test('upsertAll returning:false counts only what it wrote', async () => {
    const count = await db().loads.upsertAll([row('ins', 2), row('ins', 3)], {
      onConflict: ['batch', 'seq'],
      onMatch: 'nothing',
      returning: false,
    });
    expect(count).toBe(1);
  });

  test('a copied row is the row insertAll stores from the same input, every cell kind', async () => {
    const input = (batch: string) => Array.from({ length: 12 }, (_, seq) => row(batch, seq));
    const inserted = await db().loads.insertAll(input('viaInsert'));
    const [count, texts] = await sent(() => db().loads.copyAll(input('viaCopy')));
    expect(count).toBe(12);
    expect(texts).toEqual([
      'copy "pg_copy_live_loads" ("id", "batch", "seq", "label", "flag", "total_minor", "total_currency", "total_scale", "doc", "tags", "at", "stamped_at") from stdin',
    ]);
    const copied = await stored('viaCopy');
    expect(content(copied)).toEqual(content(inserted));
    // `defaultNow()` is filled by `$parse`, so a copied row carries its stamp exactly as an insert.
    expect(copied.every((one) => one.stampedAt instanceof Date)).toBe(true);
  });

  test('a duplicate refuses the whole copy: typed, nothing stored', async () => {
    try {
      await db().loads.copyAll([row('dup', 1), row('dup', 2), row('dup', 1)]);
      expect.unreachable('seq 1 repeats');
    } catch (error) {
      expect(isUltimateError(error) && error.code).toBe('X_DB_UNIQUE_VIOLATION');
    }
    expect(await stored('dup')).toHaveLength(0);
  });

  test('the facade parses every row whole, so a column one row omits is filled, not refused', async () => {
    const [count, texts] = await sent(() =>
      db().loads.copyAll([
        { ...row('filled', 1), label: 'x' },
        { ...row('filled', 2), label: undefined },
      ]),
    );
    expect(count).toBe(2);
    expect(texts).toHaveLength(1);
  });

  test('a repository handed rows naming different columns refuses before a statement', async () => {
    const repo = postgresRepo(loads);
    const whole = { ...row('uneven', 1), id: newId(), flag: true, stampedAt: new Date() };
    const short = { ...whole, id: newId(), seq: 2, label: undefined };
    const [outcome, texts] = await sent(() =>
      (repo.copyAll?.([whole, short]) ?? Promise.resolve(-1)).then(
        () => 'stored',
        (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
      ),
    );
    expect(outcome).toBe('X_INVARIANT_VIOLATED');
    expect(texts).toEqual([]);
  });

  test('inside a transaction: one COPY on its connection, rolled back with it', async () => {
    const rollback = await withTransaction(async () => {
      const [count, texts] = await sent(() => db().loads.copyAll([row('tx', 1), row('tx', 2)]));
      expect(count).toBe(2);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toStartWith('copy "pg_copy_live_loads"');
      expect(await stored('tx')).toHaveLength(2);
      throw new RangeError('roll it back');
    }).catch((error: unknown) => error);
    expect(rollback).toBeInstanceOf(RangeError);
    expect(await stored('tx')).toHaveLength(0);
  });

  /** `2 × MAX_ROWS_PER_COPY + 1` rows of one batch: three COPY chunks, the last of one row. */
  const chunked = (batch: string) =>
    Array.from({ length: 2 * MAX_ROWS_PER_COPY + 1 }, (_, seq) => ({
      batch,
      seq,
      total: { minor: seq, currency: 'EUR' },
    }));

  test('2N+1 rows: three COPY statements in one transaction, every row stored', async () => {
    const durations: number[] = [];
    const off = subscribe('db.statement', ({ payload }) => {
      if (payload.text.startsWith('copy "pg_copy_live_loads"')) durations.push(payload.durationMs);
    });
    const [count, texts] = await sent(() => db().loads.copyAll(chunked('bulk'))).finally(off);
    expect(count).toBe(2 * MAX_ROWS_PER_COPY + 1);
    expect(texts.filter((text) => text.startsWith('copy '))).toHaveLength(3);
    // Each chunk well inside a `web` statement_timeout. Recorded for the plan, not asserted tight.
    expect(Math.max(...durations)).toBeLessThan(5_000);
    console.info(`copyAll chunk ms: ${durations.map((ms) => Math.round(ms)).join(', ')}`);
    const [total] = await client.query<{ n: number }>(
      raw(`select count(*)::int as n from "pg_copy_live_loads" where batch = 'bulk'`),
    );
    expect(total?.n).toBe(2 * MAX_ROWS_PER_COPY + 1);
  }, 60_000);

  test('a duplicate in the last chunk undoes the two chunks before it', async () => {
    const rows = chunked('chunkdup');
    // The last chunk's one row repeats the first: refused only once two COPYs have succeeded.
    rows[rows.length - 1] = { ...rows[0], seq: 0 } as (typeof rows)[number];
    const failed = await db()
      .loads.copyAll(rows)
      .catch((error: unknown) => error);
    expect(isUltimateError(failed) && failed.code).toBe('X_DB_UNIQUE_VIOLATION');
    expect(await stored('chunkdup')).toHaveLength(0);
  }, 60_000);
});
