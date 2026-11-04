// Single responsibility: `dbDiagnostics()` against the real embedded database. A recording client
// cannot tell catalog SQL PGlite answers from SQL it refuses; this can — six sections answer, and
// `pg_stat_statements`, which PGlite never has, is a reported state with its fix.

import { afterAll, describe, expect, test } from 'bun:test';
import { dbDiagnostics, SLOW_QUERIES_FIX } from './db-diagnostics';
import { pgliteClient } from './pglite';
import { sql } from './sql';

describe('dbDiagnostics · the real embedded database', () => {
  // A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
  const PGLITE_BOOT_MS = 30_000;
  const client = pgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'six sections answer, slowQueries is unavailable with the operator fix',
    async () => {
      await client.execute(sql`create table diag_embedded (id int primary key, n int)`);
      await client.execute(sql`insert into diag_embedded values (1, -1)`);
      await client.execute(
        sql`alter table diag_embedded add constraint diag_embedded_n_check check (n > 0) not valid`,
      );
      const report = await dbDiagnostics({ client });
      expect(Object.entries(report).map(([name, section]) => [name, section.available])).toEqual([
        ['blockers', true],
        ['activity', true],
        ['slowQueries', false],
        ['unusedIndexes', true],
        ['invalidIndexes', true],
        ['notValidConstraints', true],
        ['deadTuples', true],
      ]);
      if (report.slowQueries.available) return expect.unreachable('PGlite has no extension');
      expect(report.slowQueries.fix).toBe(SLOW_QUERIES_FIX);
      if (!report.notValidConstraints.available) return expect.unreachable('answered');
      expect(report.notValidConstraints.rows.map((row) => row.constraint)).toEqual([
        'diag_embedded_n_check',
      ]);
    },
    PGLITE_BOOT_MS,
  );
});
