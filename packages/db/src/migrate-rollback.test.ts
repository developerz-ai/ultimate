// Single responsibility: an image rolled back to an OLDER build meets a ledger holding migrations
// the newer build applied. The pre-upgrade migrate Job must let that rollback through — apply
// nothing, say what it found — and still refuse every ledger that is not a rollback.

import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { type RecordingClient, recordingClient } from './fake';
import { type LedgerRow, type Migration, migrate, migrationChecksum } from './migrate';
import { ledgerAheadOfBuild } from './migrate-rollback';

const migration = (id: string): Migration => ({
  id,
  name: id.slice(15),
  up: `create table "${id.slice(15)}" ("id" uuid primary key);`,
  down: `drop table "${id.slice(15)}";`,
});

const posts = migration('20260101000000_posts');
const tags = migration('20260201000000_tags');

const row = (of: Migration | string, appVersion = '1.5.0'): LedgerRow => {
  const id = typeof of === 'string' ? of : of.id;
  return {
    id,
    name: id.slice(15),
    checksum: typeof of === 'string' ? 'sha256:from-a-newer-build' : migrationChecksum(of),
    applied_at: '2026-01-01T00:00:00.000Z',
    app_version: appVersion,
    duration_ms: 4,
  };
};

let client: RecordingClient;

beforeEach(() => {
  client = recordingClient();
  setDbClient(client);
});

const conflictOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return expect.unreachable('expected X_MIGRATION_CONFLICT, the migrator accepted the ledger');
};

describe('migrate · a rollback to an older image', () => {
  test('rows newer than every migration this build ships are accepted: nothing applied, each named', async () => {
    const newer = ['20260301000000_comments', '20260302000000_likes'];
    client.on(/from x_migrations/, {
      rows: [row(posts), row(tags), ...newer.map((id) => row(id, '1.6.0'))],
    });

    const report = await migrate({ migrations: [posts, tags], appVersion: '1.5.0', client });

    expect(report.applied).toEqual([]);
    expect(report.ahead).toEqual(newer);
    expect(client.texts.some((text) => text === 'BEGIN')).toBe(false);
    expect(client.texts.some((text) => text.includes('insert into x_migrations'))).toBe(false);
  });

  test('an ordinary ledger reports nothing ahead', async () => {
    client.on(/from x_migrations/, { rows: [row(posts)] });
    const report = await migrate({ migrations: [posts, tags], appVersion: '1.5.0', client });
    expect(report.ahead).toEqual([]);
    expect(report.applied.map((applied) => applied.id)).toEqual([tags.id]);
  });

  test('an unknown row OLDER than the newest shipped migration is still a conflict', async () => {
    // Between two migrations this build ships: a deleted or renamed migration, not a rollback.
    client.on(/from x_migrations/, {
      rows: [row(posts), row('20260115000000_deleted'), row(tags)],
    });
    expect(await conflictOf(() => migrate({ migrations: [posts, tags], client }))).toBe(
      'X_MIGRATION_CONFLICT',
    );
  });

  test('one older unknown row beside newer ones refuses the whole ledger', async () => {
    client.on(/from x_migrations/, {
      rows: [row(posts), row('20260115000000_deleted'), row(tags), row('20260301000000_new')],
    });
    expect(await conflictOf(() => migrate({ migrations: [posts, tags], client }))).toBe(
      'X_MIGRATION_CONFLICT',
    );
  });

  test('newer rows while this build still has a migration to apply are a conflict, not a rollback', async () => {
    // `tags` never ran here, so this build's schema is not the one the database holds.
    client.on(/from x_migrations/, { rows: [row(posts), row('20260301000000_new')] });
    expect(await conflictOf(() => migrate({ migrations: [posts, tags], client }))).toBe(
      'X_MIGRATION_CONFLICT',
    );
  });

  test('a build shipping no migrations at all is never read as a rollback', () => {
    expect(ledgerAheadOfBuild([row('20260301000000_new')], [])).toBeUndefined();
  });

  test('an edited migration the build ships is still a conflict under a rollback', async () => {
    const edited: Migration = { ...tags, up: 'create table "tags" ("id" uuid, "x" text);' };
    client.on(/from x_migrations/, { rows: [row(posts), row(tags), row('20260301000000_new')] });
    expect(await conflictOf(() => migrate({ migrations: [posts, edited], client }))).toBe(
      'X_MIGRATION_CONFLICT',
    );
  });
});
