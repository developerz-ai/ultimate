import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { createRecordingClient, type RecordingClient } from './fake';
import {
  auditLedger,
  type LedgerRow,
  type Migration,
  migrate,
  migrationChecksum,
  pendingMigrations,
} from './migrate';

const addPosts: Migration = {
  id: '20260101000000_create_posts',
  name: 'create posts',
  up: 'create table "posts" ("id" uuid primary key);',
  down: 'drop table "posts";',
};

const ledgerRow = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  id: addPosts.id,
  name: addPosts.name,
  checksum: migrationChecksum(addPosts),
  applied_at: '2026-01-01T00:00:00.000Z',
  app_version: '1.5.0',
  duration_ms: 4,
  ...overrides,
});

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

describe('migrate', () => {
  test('refuses and applies nothing when the ledger belongs to another app version', async () => {
    const foreign = ledgerRow({ id: '20260202000000_from_the_future', app_version: '1.6.0' });
    client.on(/from x_migrations/, { rows: [foreign] });

    let thrown: unknown;
    try {
      await migrate({ migrations: [addPosts], appVersion: '1.5.0', client });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_MIGRATION_CONFLICT');
    expect(error.cause).toContain('applied by app version "1.6.0"');
    expect(error.cause).toContain('this build is "1.5.0"');
    expect(error.fix).toContain('x db status --json');

    // Nothing ran: no BEGIN, no user DDL, no ledger insert.
    expect(client.texts.some((text) => text.includes('create table "posts"'))).toBe(false);
    expect(client.texts.some((text) => text.startsWith('BEGIN'))).toBe(false);
    expect(client.texts.some((text) => text.includes('insert into x_migrations'))).toBe(false);
    // The advisory lock is still released.
    expect(client.texts.some((text) => text.includes('pg_advisory_unlock'))).toBe(true);
  });

  test('an edited applied migration is a conflict, not a silent no-op', () => {
    const edited: Migration = { ...addPosts, up: 'create table "posts" ("id" uuid, "x" text);' };
    expect(() => auditLedger([ledgerRow()], [edited], '1.5.0')).toThrow('X_MIGRATION_CONFLICT');
  });

  test('the happy path records the ledger row and returns the --json report', async () => {
    client.on(/from x_migrations/, { rows: [] });
    client.on('insert into x_migrations', { affected: 1 });

    const report = await migrate({ migrations: [addPosts], appVersion: '1.5.0', client });

    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]?.id).toBe(addPosts.id);
    expect(report.applied[0]?.name).toBe('create posts');
    expect(typeof report.applied[0]?.durationMs).toBe('number');
    expect(report.skipped).toEqual([]);
    expect(report.appVersion).toBe('1.5.0');
    expect(typeof report.durationMs).toBe('number');

    expect(client.texts.some((text) => text.includes('create table "posts"'))).toBe(true);
    expect(client.texts.some((text) => text === 'BEGIN')).toBe(true);
    expect(client.texts.some((text) => text === 'COMMIT')).toBe(true);

    const insert = client.statements.find((statement) =>
      statement.text.includes('insert into x_migrations'),
    );
    expect(insert).toBeDefined();
    expect(insert?.values[0]).toBe(addPosts.id);
    expect(insert?.values[1]).toBe('create posts');
    expect(insert?.values[2]).toBe(migrationChecksum(addPosts));
    expect(insert?.values[3]).toBe('1.5.0');
  });

  test('an already-applied migration is skipped, not re-run', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow()] });

    const report = await migrate({ migrations: [addPosts], appVersion: '1.5.0', client });

    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([addPosts.id]);
    expect(client.texts.some((text) => text.includes('create table "posts"'))).toBe(false);
  });

  test('pendingMigrations orders by id and excludes applied ones', () => {
    const later: Migration = { ...addPosts, id: '20260303000000_add_publish_at', name: 'b' };
    const pending = pendingMigrations([ledgerRow()], [later, addPosts]);
    expect(pending.map((migration) => migration.id)).toEqual([later.id]);
  });
});
