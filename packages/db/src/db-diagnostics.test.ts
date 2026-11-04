// Single responsibility: the statement sequence `dbDiagnostics` sends and the report it builds,
// against a recording client — read-only and capped per statement, one failing section alone, an
// absent extension a reported state, and no literal or credential in what comes back.

import { describe, expect, test } from 'bun:test';
import type { DbClient } from './client';
import {
  type DbDiagnostics,
  DIAGNOSTICS_LIMIT,
  DIAGNOSTICS_TIMEOUT_MS,
  dbDiagnostics,
} from './db-diagnostics';
import {
  ACTIVITY_SQL,
  BLOCKERS_SQL,
  DEAD_TUPLES_SQL,
  INVALID_INDEXES_SQL,
  NOT_VALID_CONSTRAINTS_SQL,
  SLOW_QUERIES_SQL,
  UNUSED_INDEXES_SQL,
} from './db-diagnostics-sql';
import { dbUnavailable, driverError } from './errors';
import { type RecordingClient, recordingClient } from './fake';
import type { SqlFragment } from './sql';

const SECTIONS = [
  BLOCKERS_SQL,
  ACTIVITY_SQL,
  SLOW_QUERIES_SQL,
  UNUSED_INDEXES_SQL,
  INVALID_INDEXES_SQL,
  NOT_VALID_CONSTRAINTS_SQL,
  DEAD_TUPLES_SQL,
];

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A recording client whose statement containing `match` rejects with `error` — once per send. */
function failing(base: RecordingClient, match: string, error: unknown): DbClient {
  const guard = async (fragment: SqlFragment): Promise<void> => {
    if (fragment.text.includes(match)) throw error;
  };
  return {
    query: async <T>(fragment: SqlFragment) => {
      await guard(fragment);
      return base.query<T>(fragment);
    },
    one: async <T>(fragment: SqlFragment) => {
      await guard(fragment);
      return base.one<T>(fragment);
    },
    execute: async (fragment: SqlFragment) => {
      await guard(fragment);
      return base.execute(fragment);
    },
  };
}

/**
 * Rows for the section whose statement contains a key. The cursor's FETCH text is the same for all
 * seven, so the answer follows the DECLARE sent just before it on this connection.
 */
function answering(rowsFor: Readonly<Record<string, readonly unknown[]>>): RecordingClient {
  const base = recordingClient();
  let declared = '';
  const rowsOf = (fragment: SqlFragment): readonly unknown[] | undefined => {
    if (fragment.text.startsWith('DECLARE')) declared = fragment.text;
    if (!fragment.text.startsWith('FETCH')) return undefined;
    const key = Object.keys(rowsFor).find((match) => declared.includes(match));
    return key === undefined ? undefined : rowsFor[key];
  };
  return {
    ...base,
    get texts() {
      return base.texts;
    },
    query: async <T>(fragment: SqlFragment) => {
      const rows = rowsOf(fragment);
      const recorded = await base.query<T>(fragment);
      return rows === undefined ? recorded : (rows as readonly T[]);
    },
    execute: async (fragment: SqlFragment) => {
      rowsOf(fragment);
      return base.execute(fragment);
    },
  };
}

const KEYS: readonly (keyof DbDiagnostics)[] = [
  'blockers',
  'activity',
  'slowQueries',
  'unusedIndexes',
  'invalidIndexes',
  'notValidConstraints',
  'deadTuples',
];

describe('dbDiagnostics', () => {
  test('a probe, then seven statements, each its own read-only, timed, capped transaction', async () => {
    const client = recordingClient();
    await dbDiagnostics({ client });
    const expected = [
      [
        'BEGIN READ ONLY',
        `SET LOCAL statement_timeout = ${DIAGNOSTICS_TIMEOUT_MS}`,
        'select 1',
        'ROLLBACK',
      ],
      ...SECTIONS.map((statement) => [
        'BEGIN READ ONLY',
        `SET LOCAL statement_timeout = ${DIAGNOSTICS_TIMEOUT_MS}`,
        squash(`DECLARE ultimate_read_cursor NO SCROLL CURSOR FOR ${statement}`),
        `FETCH FORWARD ${DIAGNOSTICS_LIMIT} FROM ultimate_read_cursor`,
        'ROLLBACK',
      ]),
    ].flat();
    expect(client.texts).toEqual(expected);
  });

  test('limit is the cursor fetch, and a limit that is not a count is refused unsent', async () => {
    const client = recordingClient();
    await dbDiagnostics({ client, limit: 3 });
    expect(client.texts.filter((text) => text.startsWith('FETCH'))).toHaveLength(7);
    expect(client.texts).toContain('FETCH FORWARD 3 FROM ultimate_read_cursor');

    const refused = recordingClient();
    const error = await dbDiagnostics({ client: refused, limit: 0 }).catch((e: unknown) => e);
    expect(String((error as { code?: string }).code)).toBe('X_INVARIANT');
    expect(refused.texts).toEqual([]);
  });

  test('one section throwing leaves the other six answered', async () => {
    const base = answering({
      pg_stat_user_tables: [{ schema: 'public', table_name: 'posts', dead: 7 }],
    });
    const timeout = driverError('select', Object.assign(new Error('canceled'), { errno: '57014' }));
    const report = await dbDiagnostics({ client: failing(base, 'pg_blocking_pids', timeout) });
    expect(report.blockers).toMatchObject({ available: false, code: 'X_DB_STATEMENT_TIMEOUT' });
    for (const key of KEYS.filter((name) => name !== 'blockers' && name !== 'slowQueries')) {
      expect([key, report[key].available]).toEqual([key, true]);
    }
    expect(report.deadTuples).toEqual({
      available: true,
      rows: [
        {
          schema: 'public',
          table: 'posts',
          live: null,
          dead: 7,
          autovacuumAgeSeconds: null,
          vacuumAgeSeconds: null,
          analyzeAgeSeconds: null,
        },
      ],
    });
  });

  test('pg_stat_statements absent is available: false with the operator fix, not a throw', async () => {
    const stale = driverError('select', Object.assign(new Error('missing'), { errno: '42P01' }));
    const report = await dbDiagnostics({
      client: failing(recordingClient(), 'pg_stat_statements', stale),
    });
    expect(report.slowQueries.available).toBe(false);
    if (report.slowQueries.available) return;
    expect(report.slowQueries.code).toBe('X_DB_SCHEMA_STALE');
    expect(report.slowQueries.fix).toContain('create extension if not exists pg_stat_statements');
    expect(report.slowQueries.fix).toContain('shared_preload_libraries');
    expect(report.slowQueries.fix).not.toContain('x db gen');
  });

  test('no connection is the one throw: X_DB_UNAVAILABLE, and nothing past the probe', async () => {
    const base = recordingClient();
    const error = await dbDiagnostics({
      client: failing(base, 'BEGIN', dbUnavailable('connect ECONNREFUSED')),
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('X_DB_UNAVAILABLE');
    expect(base.texts.filter((text) => text.startsWith('DECLARE'))).toEqual([]);
  });

  test('a session query is shaped, never carried; a hidden one is reported, not guessed', async () => {
    const client = answering({
      backend_type: [
        {
          pid: 41,
          state: 'active',
          query_visible: true,
          query: "update users set email = 'ada@example.com' where id = 9",
        },
        { pid: 42, query_visible: false, query: '<insufficient privilege>' },
      ],
    });
    const report = await dbDiagnostics({ client });
    expect(report.activity.available).toBe(true);
    if (!report.activity.available) return;
    expect(report.activity.rows.map((row) => [row.pid, row.queryVisible, row.query])).toEqual([
      [41, true, 'update users set email = ? where id = ?'],
      [42, false, null],
    ]);
  });

  test('a credential in a section failure never reaches its reason', async () => {
    const leak = dbUnavailable('dial postgres://app:hunter2@db.internal:5432/app failed');
    const report = await dbDiagnostics({
      client: failing(recordingClient(), 'pg_constraint', leak),
    });
    expect(report.notValidConstraints.available).toBe(false);
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(JSON.stringify(report)).toContain('postgres://***@db.internal');
  });

  test('int8 counters arrive as text or bigint and leave as numbers', async () => {
    const client = answering({
      pg_stat_user_indexes: [
        { index_name: 'posts_title_idx', size_bytes: '8192', stats_age_seconds: 10n },
      ],
    });
    const report = await dbDiagnostics({ client });
    if (!report.unusedIndexes.available) return expect.unreachable('unusedIndexes answered');
    expect(report.unusedIndexes.rows[0]).toMatchObject({ sizeBytes: 8192, statsAgeSeconds: 10 });
  });
});
