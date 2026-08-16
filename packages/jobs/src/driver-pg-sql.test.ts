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

  test('the old global idempotency index is DROPPED, not left beside the new one', () => {
    // Left in place it would keep enforcing exactly the collision the new one fixes: two
    // different jobs deriving the same natural key, the second silently deduped into the first.
    expect(SQL_JOBS_TABLE).toContain('drop index if exists x_jobs_idempotency_live_idx');
    expect(SQL_JOBS_TABLE).toContain('on x_jobs (name, idempotency_key)');
    expect(SQL_JOBS_TABLE).not.toMatch(/on x_jobs \(idempotency_key\)/);
  });

  test('the standalone x_outbox constant matches the one inside the install point', () => {
    // Two declarations of one table is how the outbox came to be documented and never created.
    for (const line of SQL_OUTBOX_TABLE.split('\n')) {
      if (line.trim().length === 0) continue;
      expect(SQL_JOBS_TABLE).toContain(line.trim());
    }
  });
});
