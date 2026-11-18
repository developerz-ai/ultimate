// Every framework jobs statement, EXPLAIN ANALYZEd against a seeded queue (tens of thousands of
// `x_jobs` rows across states, queues and tenants) inside a transaction that is rolled back. A
// sequential scan of `x_jobs` or `x_outbox`, or any node of either reading past `READ_FLOOR`, fails
// it: those two grow with what the queue has
// finished, so a scan of either costs more every day the app runs (182k scans reading 4.55B tuples,
// production 2026-11-14, from a statement evicted out of `pg_stat_statements`). The table of cases
// is held equal to the `export const SQL_*` the package source declares, so no new statement
// escapes it. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { Glob } from 'bun';
import { SQL_JOBS_TABLE } from './driver-pg-ddl';
import type { PlannedStatement } from './statement-plans-cases-fixture';
import { planned } from './statement-plans-cases-fixture';
import { SEED_STATEMENTS, SEEDED_FLOOR } from './statement-plans-seed-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_statement_plans_live');
const SRC = import.meta.dir;

/** The table's SHAPE — names and labels, which the tests are declared by. Bound values come later. */
const SHAPE = planned(0);

/** The tables a scan of which grows with the queue's history. */
const WATCHED = new Set(Object.keys(SEEDED_FLOOR));

/**
 * The most rows one scan node may read (produced plus filtered out, over its loops). Every live row
 * the seed holds, retained dead and failed ones included, is under it, so a statement over it is
 * reading the FINISHED history — the scan in another shape: a bitmap of the whole table, or an index
 * walked end to end behind a filter.
 */
const READ_FLOOR = 5_000;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** Every `export const SQL_*` in this package's production source, by name. */
const declaredStatements = async (): Promise<readonly string[]> => {
  const names: string[] = [];
  for await (const file of new Glob('*.ts').scan({ cwd: SRC })) {
    if (file.endsWith('.test.ts')) continue;
    const source = await Bun.file(`${SRC}/${file}`).text();
    for (const match of source.matchAll(/^export const (SQL_[A-Z0-9_]+)\b/gm)) {
      if (match[1] !== undefined) names.push(match[1]);
    }
  }
  return names.filter((name) => name !== 'SQL_JOBS_TABLE').sort();
};

interface ScanNode {
  readonly type: string;
  readonly relation: string;
  readonly index: string | undefined;
  /** Rows the node produced plus the rows its filter threw away, over every loop. */
  readonly read: number;
}

const numberAt = (node: Record<string, unknown>, key: string): number => {
  const value = node[key];
  return typeof value === 'number' ? value : 0;
};

/** Every scan node of an `explain (format json)` tree that reads a watched table. */
const scansOf = (node: unknown, into: ScanNode[] = []): ScanNode[] => {
  if (typeof node !== 'object' || node === null) return into;
  const record = node as Record<string, unknown>;
  const relation = record['Relation Name'];
  if (typeof relation === 'string' && WATCHED.has(relation)) {
    const loops = Math.max(1, numberAt(record, 'Actual Loops'));
    const read =
      (numberAt(record, 'Actual Rows') +
        numberAt(record, 'Rows Removed by Filter') +
        numberAt(record, 'Rows Removed by Index Recheck')) *
      loops;
    const index = record['Index Name'];
    into.push({
      type: String(record['Node Type']),
      relation,
      index: typeof index === 'string' ? index : undefined,
      read,
    });
  }
  const plans = record['Plans'];
  if (Array.isArray(plans)) for (const child of plans) scansOf(child, into);
  return into;
};

/** Every index any node of the tree reads, a bitmap's included: those carry no relation name. */
const indexesOf = (node: unknown, into: Set<string>): Set<string> => {
  if (typeof node !== 'object' || node === null) return into;
  const record = node as Record<string, unknown>;
  const index = record['Index Name'];
  if (typeof index === 'string') into.add(index);
  const plans = record['Plans'];
  if (Array.isArray(plans)) for (const child of plans) indexesOf(child, into);
  return into;
};

const render = (scan: ScanNode): string =>
  `${scan.type} on ${scan.relation}${scan.index === undefined ? '' : ` using ${scan.index}`} (${scan.read} rows read)`;

describe.skipIf(!hasPostgres)('live · postgres · every jobs statement plans without a scan', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  /** The cases at the database's own instant, read once the seed is in. */
  let cases: Readonly<Record<string, PlannedStatement>> = SHAPE;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 1 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    for (const statement of SEED_STATEMENTS) await client.execute(raw(statement));
    const clock = await client.query<{ now: number | string }>({
      text: 'select (extract(epoch from now()) * 1000)::bigint as now',
      values: [],
    });
    cases = planned(Number(clock[0]?.now));
    // Here and not in the case tests: the index test below reads what ALL of them read.
    for (const [name, statement] of Object.entries(SHAPE)) {
      for (const index of statement.cases.keys()) {
        await plan(statement.sql, cases[name]?.cases[index]?.params ?? []);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('the case table names every statement the source declares, and only those', async () => {
    expect(Object.keys(SHAPE).sort()).toEqual([...(await declaredStatements())]);
  });

  test('the seed is big enough that a scan is a defect, not a planner preference', async () => {
    for (const [table, floor] of Object.entries(SEEDED_FLOOR)) {
      const rows = await client.query<{ n: number }>({
        text: `select count(*)::int as n from ${table}`,
        values: [],
      });
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(floor);
    }
  });

  /** Every index the cases below read, for the last test: an index no statement reads is pure write. */
  const read = new Set<string>();

  /** One case, run for real and rolled back: what it read, and how. */
  const plan = async (sql: string, params: readonly unknown[]): Promise<readonly ScanNode[]> => {
    using connection = await client.reserve();
    await connection.query({ text: 'begin', values: [] });
    try {
      const rows = await connection.query<Record<string, unknown>>({
        text: `explain (analyze, timing off, format json) ${sql}`,
        values: [...params],
      });
      const doc = Object.values(rows[0] ?? {})[0];
      const tree = Array.isArray(doc) ? (doc[0] as Record<string, unknown>)['Plan'] : undefined;
      indexesOf(tree, read);
      return scansOf(tree);
    } finally {
      await connection.query({ text: 'rollback', values: [] });
    }
  };

  for (const [name, statement] of Object.entries(SHAPE)) {
    for (const [index, { label }] of statement.cases.entries()) {
      test(`${name} · ${label}: no scan of x_jobs or x_outbox past the floor`, async () => {
        const scans = await plan(statement.sql, cases[name]?.cases[index]?.params ?? []);
        const offending = scans
          .filter((scan) => scan.type === 'Seq Scan' || scan.read > READ_FLOOR)
          .map(render);
        // The whole plan rides the failure: which index each node did read, beside the one that scanned.
        expect({ name, offending, scans: scans.map(render) }).toEqual({
          name,
          offending: [],
          scans: scans.map(render),
        });
      }, 30_000);
    }
  }

  // Every index on the two tables has a reader. An
  // index that none of them reads costs a write on every insert and every non-HOT update, for nothing
  // — the question `x_jobs_created_idx` was asked, and answered by `SQL_JOB_LIST` and the enqueue wake.
  test('every index on x_jobs and x_outbox is read by some statement', async () => {
    const rows = await client.query<{ indexname: string }>({
      text: 'select indexname from pg_indexes where tablename = any($1::text[]) order by indexname',
      values: [[...WATCHED]],
    });
    const unread = rows.map((row) => row.indexname).filter((index) => !read.has(index));
    expect(unread).toEqual([]);
  });
});
