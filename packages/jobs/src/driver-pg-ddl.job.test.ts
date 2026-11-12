// The queue DDL against a real Postgres (the embedded one): the index set it converges a database
// to, applied the way the boot applies it (in one transaction, again on every build), and the
// indexes retention reads through it.
// Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { SQL_JOBS_TABLE } from './driver-pg-ddl';
import { embeddedPg } from './embedded-pg-fixture';
import { SQL_JOBS_RETENTION_BATCH } from './jobs-retention';

/** The embedded boot alone is tens of seconds (`driver-pg-lifecycle.job.test.ts`). */
setDefaultTimeout(120_000);

const DAY_MS = 86_400_000;

afterAll(async () => {
  await (await embeddedPg()).close();
});

async function apply(): Promise<void> {
  const { executor } = await embeddedPg();
  for (const statement of SQL_JOBS_TABLE.split(';')) {
    if (statement.trim().length > 0) await executor.query(statement, []);
  }
}

async function jobIndexes(): Promise<readonly string[]> {
  const { executor } = await embeddedPg();
  const rows = await executor.query<{ name: string }>(
    `select indexname as name from pg_indexes where tablename = 'x_jobs' order by indexname`,
    [],
  );
  return rows.map((row) => row.name);
}

async function plan(text: string, values: readonly unknown[]): Promise<string> {
  const { executor } = await embeddedPg();
  // Seq scans off: a test table is a page or two, and the question is which INDEX serves the read.
  await executor.query('set enable_seqscan = off', []);
  try {
    const rows = await executor.query<{ 'QUERY PLAN': string }>(`explain ${text}`, values);
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  } finally {
    await executor.query('reset enable_seqscan', []);
  }
}

describe('pg · the queue DDL', () => {
  test('a database an earlier boot built converges: the overlapping finished index goes', async () => {
    const { executor } = await embeddedPg();
    // The 31.x shape: the four-state index the done-only one duplicates, at the default fillfactor.
    await executor.query(
      `create index if not exists x_jobs_finished_idx on x_jobs (updated_at)
        where state in ('done', 'failed', 'dead', 'cancelled')`,
      [],
    );
    await executor.query('alter table x_jobs reset (fillfactor)', []);
    await apply();
    const names = await jobIndexes();
    expect(names).not.toContain('x_jobs_finished_idx');
    expect(names).toContain('x_jobs_ended_idx');
    expect(names).toContain('x_jobs_done_idx');
    const options = await executor.query<{ options: string[] | null }>(
      `select reloptions as options from pg_class where relname = 'x_jobs'`,
      [],
    );
    expect(options[0]?.options).toEqual(['fillfactor=80']);
  });

  // `applyLockedSchema` (`@ultimat3/cli`) runs every framework statement in ONE transaction, behind
  // the migration lock: a `concurrently` here is `25001` on every production boot.
  test('it applies inside one transaction, as the locked boot apply runs it', async () => {
    await (await embeddedPg()).transaction(async (tx) => {
      for (const statement of SQL_JOBS_TABLE.split(';')) {
        if (statement.trim().length > 0) await tx.query(statement, []);
      }
    });
    expect(await jobIndexes()).toContain('x_jobs_ended_idx');
  });

  test('applying it again changes nothing: every boot runs it', async () => {
    const before = await jobIndexes();
    await apply();
    expect(await jobIndexes()).toEqual(before);
  });

  test('the ended index holds no done row: retention reads done through its own index', async () => {
    const { executor } = await embeddedPg();
    const rows = await executor.query<{ predicate: string }>(
      `select pg_get_expr(i.indpred, i.indrelid) as predicate
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'x_jobs_ended_idx'`,
      [],
    );
    expect(rows[0]?.predicate).not.toContain("'done'");
    expect(rows[0]?.predicate).toContain("'cancelled'");
  });

  test('each retention branch seeks its own partial index', async () => {
    const shown = await plan(SQL_JOBS_RETENTION_BATCH, [14 * DAY_MS, 90 * DAY_MS, 100]);
    expect(shown).toContain('using x_jobs_done_idx on x_jobs');
    expect(shown).toContain('using x_jobs_ended_idx on x_jobs');
  });
});
