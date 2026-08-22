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
import { SQL_JOBS_TABLE, SQL_OUTBOX_TABLE } from './driver-pg-sql';

/** Every file in this package that compiles SQL. A new one joins the list or it is unguarded. */
const PG_SOURCES = [
  'driver-pg.ts',
  'driver-pg-sql.ts',
  'driver-pg-jobs-sql.ts',
  'events-pg.ts',
  'outbox-pg.ts',
  'scheduler-pg.ts',
] as const;

/** Prose quotes both forms on purpose — a scan that reads comments reports its own explanation. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

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

  test('the standalone x_outbox constant matches the one inside the install point', () => {
    // Two declarations of one table is how the outbox came to be documented and never created.
    for (const line of SQL_OUTBOX_TABLE.split('\n')) {
      if (line.trim().length === 0) continue;
      expect(SQL_JOBS_TABLE).toContain(line.trim());
    }
  });
});

describe("the pg driver's reads", () => {
  // `PgExecutor` is an injected seam over any client that speaks `(text, values)`, and a client
  // with no type map decodes `timestamptz` as TEXT. `toJobRecord`/`toStepRecord` then read
  // `Number('2026-01-01 00:00:00+00')` — `NaN` for every epoch field, printed by `x jobs ls`,
  // `x jobs show` and `x jobs cancel`. Five statements were `select *`/`returning *` and shipped
  // that way; asking Postgres for epoch ms is what makes the decoding the statement's business.
  test('no statement returns a whole row, so no epoch column depends on the client type map', async () => {
    const offenders: string[] = [];
    for (const name of PG_SOURCES) {
      const source = withoutComments(await Bun.file(`${import.meta.dir}/${name}`).text());
      for (const hit of source.matchAll(/\b(select|returning)\s+\*/g)) {
        offenders.push(`${name}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
