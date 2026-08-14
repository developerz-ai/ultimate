// `dev-queue.ts` applies `SQL_JOBS_TABLE` by splitting it on `;` — PGlite speaks the extended
// protocol, which carries one statement per round trip — and names this file as where that stays
// safe. So this is what it pins: every chunk is a whole DDL statement, and no `;` in the constant
// is data. A `;` inside a string literal or a dollar-quoted body would split a statement in half
// and the queue would come up with half a schema, in `x dev` only.

import { describe, expect, test } from 'bun:test';
import { SQL_JOBS_TABLE } from './driver-pg-sql';

const statements = SQL_JOBS_TABLE.split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

describe('the queue DDL', () => {
  test('every chunk the `;` split yields is a whole create statement', () => {
    for (const statement of statements) {
      // Comments lead several of them, and a chunk is a statement only after they are dropped.
      const code = statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim();
      expect(code).toMatch(/^create (table|unique index|index) if not exists /);
    }
  });

  test('no `;` in the constant is data, so nothing splits inside a literal', () => {
    // Every quote pairs up: an odd count would mean a `;` sits inside an open literal somewhere,
    // which is exactly the case the split cannot see.
    expect((SQL_JOBS_TABLE.match(/'/g) ?? []).length % 2).toBe(0);
    expect(SQL_JOBS_TABLE).not.toContain('$$');
  });

  test('declares the three tables the queue and the backfill ledger need', () => {
    const tables = statements
      .map((statement) => /create table if not exists (\w+)/.exec(statement)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(tables).toEqual(['x_jobs', 'x_job_steps', 'x_backfills']);
  });
});
