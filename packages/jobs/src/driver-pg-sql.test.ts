// `dev-queue.ts` applies `SQL_JOBS_TABLE` by splitting it on `;` — PGlite speaks the extended
// protocol, which carries one statement per round trip — and names this file as where that stays
// safe. So this is what it pins: every chunk is a whole DDL statement, and no `;` in the constant
// is data. A `;` inside a string literal or a dollar-quoted body would split a statement in half
// and the queue would come up with half a schema, in `x dev` only.
//
// The constant itself moved to `driver-pg-ddl.ts` when this file crossed the size ceiling, and is
// re-exported from `driver-pg-sql.ts` so no importer moved. The rule travels with the constant,
// not with the filename: whichever file holds the DDL is the one that must keep `;` and `'` out
// of its comments.

import { describe, expect, test } from 'bun:test';
import { SQL_JOBS_TABLE } from './driver-pg-sql';

/** Prose quotes both forms on purpose — a scan that reads comments reports its own explanation. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

/**
 * Every production file in this package, DISCOVERED. A hand-kept list is a guard a new file opts
 * out of by existing — `driver-pg-ddl.ts` was already missing from the one this replaces — so the
 * scan reads the directory instead and a source added tomorrow is covered the day it lands.
 */
const pgSources = async (): Promise<readonly string[]> => {
  const names: string[] = [];
  for await (const name of new Bun.Glob('*.ts').scan({ cwd: import.meta.dir, absolute: false })) {
    if (!name.endsWith('.test.ts')) names.push(name);
  }
  return names.sort();
};

const statements = SQL_JOBS_TABLE.split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const codeOf = (statement: string): string =>
  statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe('the queue DDL', () => {
  test('every chunk the `;` split yields is a whole idempotent statement', () => {
    for (const statement of statements) {
      // Comments lead several of them, and a chunk is a statement only after they are dropped.
      // `alter`/`drop` join `create` because `x_jobs` SHIPPED: `create table if not exists` is a
      // no-op against a database that already has the table, so a column added only there would
      // reach new installs and nothing else.
      expect(codeOf(statement)).toMatch(
        /^(create (table|unique index|index) if not exists |alter table \w+ add column if not exists |drop index if exists )/,
      );
    }
  });

  test('no `;` in the constant is data, so nothing splits inside a literal', () => {
    // Every quote pairs up: an odd count would mean a `;` sits inside an open literal somewhere,
    // which is exactly the case the split cannot see. Comments in this constant carry no
    // apostrophes for the same reason — the parity check cannot tell prose from a literal.
    expect((SQL_JOBS_TABLE.match(/'/g) ?? []).length % 2).toBe(0);
    expect(SQL_JOBS_TABLE).not.toContain('$$');
  });

  test('declares every durable table the queue owns, in dependency-free order', () => {
    const tables = statements
      .map((statement) => /create table if not exists (\w+)/.exec(statement)?.[1])
      .filter((name): name is string => name !== undefined);
    // One install point. Each of the last four was a subsystem that shipped fully built with no
    // table behind it: the outbox, the scheduler's watermark and its leader, `job.concurrency`,
    // and `step.waitForEvent`'s bus.
    expect(tables).toEqual([
      'x_jobs',
      'x_job_steps',
      'x_backfills',
      'x_outbox',
      'x_scheduler_state',
      'x_scheduler_leader',
      'x_job_leases',
      'x_job_events',
    ]);
  });

  test('every superseded idempotency index is DROPPED, not left beside the new one', () => {
    // Left in place, either would keep enforcing exactly the collision the new one fixes: the
    // key-only index across two different jobs, the name-only index across two different TENANTS.
    // Each is strictly narrower than its successor, so both drops are load-bearing.
    expect(SQL_JOBS_TABLE).toContain('drop index if exists x_jobs_idempotency_live_idx');
    expect(SQL_JOBS_TABLE).toContain('drop index if exists x_jobs_name_idempotency_live_idx');
    expect(SQL_JOBS_TABLE).toContain(
      "on x_jobs (name, (coalesce(tenant_id, '')), idempotency_key)",
    );
    expect(SQL_JOBS_TABLE).not.toMatch(/on x_jobs \(idempotency_key\)/);
    expect(SQL_JOBS_TABLE).not.toMatch(/on x_jobs \(name, idempotency_key\)/);
  });

  test('x_outbox is created by the install point, and by nothing else', () => {
    // `SQL_OUTBOX_TABLE` was a byte-for-byte second copy of these statements, exported and applied
    // by nothing — two install points for one table is how the outbox came to be documented and
    // never created. `scripts/framework-tables.ts` is the standing guard; this pins the survivor.
    expect(SQL_JOBS_TABLE).toContain('create table if not exists x_outbox');
    expect(SQL_JOBS_TABLE).toContain('create index if not exists x_outbox_unpublished_idx');
    expect(SQL_JOBS_TABLE).toContain('alter table x_outbox add column if not exists claimed_at');
    expect(SQL_JOBS_TABLE).toContain('alter table x_outbox add column if not exists claimed_by');
  });
});

describe("the pg driver's reads", () => {
  // `PgExecutor` is an injected seam over any client that speaks `(text, values)`, and a client
  // with no type map decodes `timestamptz` as TEXT. `toJobRecord`/`toStepRecord` then read
  // `Number('2026-01-01 00:00:00+00')` — `NaN` for every epoch field, printed by `x jobs ls`,
  // `x jobs show` and `x jobs cancel`. Six statements were `select *`/`returning *` and shipped
  // that way; asking Postgres for epoch ms is what makes the decoding the statement's business.
  test('no statement returns a whole row, so no epoch column depends on the client type map', async () => {
    const sources = await pgSources();
    // The discovery itself can fail — a glob that matches nothing passes every assertion below
    // and reports a guard that ran over no files as green.
    expect(sources).toContain('driver-pg-jobs-sql.ts');
    expect(sources).toContain('driver-pg-ddl.ts');

    const offenders: string[] = [];
    for (const name of sources) {
      const source = withoutComments(await Bun.file(`${import.meta.dir}/${name}`).text());
      // Case-insensitive: Postgres reads `SELECT *` and `select *` alike, so a guard that reads
      // only one of them is a spelling away from missing the statement it exists to catch.
      for (const hit of source.matchAll(/\b(select|returning)\s+\*/gi)) {
        offenders.push(`${name}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
