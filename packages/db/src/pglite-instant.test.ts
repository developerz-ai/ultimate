// Single responsibility: a whole `timestamptz` row read back from REAL PGlite under a session zone
// that is not UTC. PGlite's own text parser answered Invalid Date for year `0099` under
// `America/New_York` (an offset with seconds) and 1999 under UTC — reproduced before the fix.

import { afterAll, describe, expect, test } from 'bun:test';
import { createPgliteClient } from './pglite';
import { raw } from './sql';

const PGLITE_BOOT_MS = 60_000;

describe('a timestamptz read from embedded Postgres', () => {
  const client = createPgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'is the stored instant under every session zone',
    async () => {
      await client.execute(raw('create table pi_events (at timestamptz, plain timestamp)'));
      await client.execute(
        raw(
          "insert into pi_events values ('0099-06-01T00:00:00Z', '0099-06-01 00:00'), " +
            "('1900-01-01T12:00:00Z', '1900-01-01 12:00'), ('2026-09-23T10:15:30.123Z', '2026-09-23 10:15:30.123')",
        ),
      );
      for (const zone of ['UTC', 'Europe/Amsterdam', 'America/New_York']) {
        await client.execute(raw(`set time zone '${zone}'`));
        const rows = await client.query<{ at: Date; plain: Date }>(
          raw('select at, plain from pi_events order by at'),
        );
        expect(rows.map((row) => row.at.toISOString())).toEqual([
          '0099-06-01T00:00:00.000Z',
          '1900-01-01T12:00:00.000Z',
          '2026-09-23T10:15:30.123Z',
        ]);
        // A `timestamp` is read as UTC, never through the HOST process's zone.
        expect(rows.map((row) => row.plain.toISOString())).toEqual([
          '0099-06-01T00:00:00.000Z',
          '1900-01-01T12:00:00.000Z',
          '2026-09-23T10:15:30.123Z',
        ]);
      }
    },
    PGLITE_BOOT_MS,
  );
});
