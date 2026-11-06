// Single responsibility: a `-- transaction: false` migration that builds an index concurrently on a
// PARTITIONED parent fails as `X_MIGRATION_CONCURRENT_PARTITIONED`, the server's `0A000` kept as
// `sourceError` — where it used to arrive as a bare `X_DB_STATEMENT_FAILED`. And the fix's own
// sequence, run as such a migration, applies. Real embedded database.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { NO_TRANSACTION_MARKER } from './concurrent-index';
import { DbError } from './errors';
import { migrate } from './migrate';
import type { Migration } from './migration-ledger';
import { pgliteClient } from './pglite';
import { raw } from './sql';
import { sqlState } from './sqlstate';

const PGLITE_BOOT_MS = 60_000;

const create: Migration = {
  id: '20261101000000_create_events',
  name: 'create events',
  up: [
    'create table events (id uuid not null, at date not null, kind text not null,',
    '  primary key (id, at)) partition by range (at);',
    "create table events_2026_11 partition of events for values from ('2026-11-01') to ('2026-12-01');",
  ].join('\n'),
  down: '',
};

const step = (id: string, ...statements: readonly string[]): Migration => ({
  id,
  name: id,
  up: [NO_TRANSACTION_MARKER, ...statements].join('\n'),
  down: '',
});

describe('a concurrent build on a partitioned table', () => {
  const client = pgliteClient();

  beforeEach(async () => {
    await client.execute(raw('drop schema public cascade'));
    await client.execute(raw('create schema public'));
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test('is X_MIGRATION_CONCURRENT_PARTITIONED, the original still its sourceError', async () => {
    const build = step(
      '20261102000000_index_kind',
      'create index concurrently if not exists "events_kind_idx" on "events" ("kind");',
    );
    const refusal = await migrate({ migrations: [create, build], appVersion: 'test', client }).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(refusal instanceof DbError)) expect.unreachable('the build must be refused');
    expect(refusal.code).toBe('X_MIGRATION_CONCURRENT_PARTITIONED');
    expect(refusal.cause).toContain('20261102000000_index_kind');
    expect(refusal.fix).toStartWith('CREATE INDEX CONCURRENTLY');
    expect(refusal.sourceError).toBeInstanceOf(DbError);
    expect(sqlState(refusal.sourceError)).toBe('0A000');
  });

  test('the sequence the fix names applies, and leaves one valid index on the parent', async () => {
    const sequence = step(
      '20261102000000_index_kind',
      'create index concurrently if not exists "events_kind_idx_2026_11" on "events_2026_11" ("kind");',
      'create index if not exists "events_kind_idx" on only "events" ("kind");',
      'alter index "events_kind_idx" attach partition "events_kind_idx_2026_11";',
    );
    await migrate({ migrations: [create, sequence], appVersion: 'test', client });
    const row = await client.one<{ valid: boolean }>(
      raw(
        `select indisvalid as valid from pg_index where indexrelid = 'events_kind_idx'::regclass`,
      ),
    );
    // Valid once every partition is attached — `on only` alone leaves it invalid.
    expect(row?.valid).toBe(true);
  });
});
