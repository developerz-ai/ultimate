// Entities ahead of the migrations, said by the generation: the instruction is the whole one —
// generate AND migrate, since `x dev` applies no migration — and a failed check never fails a boot.
// The ledger behind the migrations on disk is said the same way: `x db gen` alone is not green.

import { describe, expect, test } from 'bun:test';
import { migrationChecksum } from '@ultimat3/db';
import { ledgerFindings, SCHEMA_AHEAD_FIX, schemaAheadFindings } from './dev-rebuild-schema';
import type { Finding } from './output';

const drift: Finding = {
  code: 'X_DB_DRIFT',
  cause: 'schema hashes to abc, newest migration 0001_init.hash recorded def',
  fix: 'x db gen "describe the change"',
  at: 'packages/db/src',
};

describe('schemaAheadFindings', () => {
  test('a drifted schema is X_DB_DRIFT with the gen-and-migrate instruction', async () => {
    const [finding] = await schemaAheadFindings('/app', async () => [drift]);
    expect(finding?.code).toBe('X_DB_DRIFT');
    expect(finding?.cause).toBe(`entities are ahead of the migrations: ${drift.cause}`);
    expect(finding?.fix).toBe('x db gen "describe the change" && x db migrate');
    expect(finding?.at).toBe('packages/db/src');
    expect(SCHEMA_AHEAD_FIX).toContain('x db migrate');
  });

  test('a schema the migrations recorded says nothing', async () => {
    expect(await schemaAheadFindings('/app', async () => [])).toEqual([]);
  });

  test('a check that throws is a finding, never a rejection', async () => {
    const findings = await schemaAheadFindings('/app', () =>
      Promise.reject(new TypeError('hash sidecar unreadable')),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cause).toContain('hash sidecar unreadable');
  });
});

const posts = {
  id: '0001_posts',
  name: 'posts',
  up: 'create table posts (id uuid primary key);',
  down: 'drop table posts;',
};
const notes = { ...posts, id: '0002_notes', name: 'notes', up: 'create table notes (id uuid);' };
const applied = (migration: typeof posts, checksum?: string) => ({
  id: migration.id,
  checksum: checksum ?? migrationChecksum(migration),
});

describe('ledgerFindings', () => {
  // `x db gen` beside a running dev: the files are ahead of the database, every read of the new
  // column is a 500, and the banner said `✓ dev ready`.
  test('a migration on disk the ledger lacks is X_APP_MIGRATIONS_UNAPPLIED, fix x db migrate', async () => {
    const findings = await ledgerFindings('/app', {
      database: () => true,
      migrations: async () => [posts, notes],
      ledger: async () => [applied(posts)],
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_APP_MIGRATIONS_UNAPPLIED']);
    expect(findings[0]?.cause).toContain('0002_notes');
    expect(findings[0]?.cause).not.toContain('0001_posts');
    expect(findings[0]?.fix).toBe('x db migrate');
  });

  test('an applied migration edited since is X_MIGRATION_CONFLICT', async () => {
    const findings = await ledgerFindings('/app', {
      database: () => true,
      migrations: async () => [posts],
      ledger: async () => [applied(posts, 'applied-under-another-text')],
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_MIGRATION_CONFLICT']);
  });

  test('a ledger that holds every migration says nothing, and neither does an app with none', async () => {
    const current = {
      database: () => true,
      migrations: async () => [posts],
      ledger: async () => [applied(posts)],
    };
    expect(await ledgerFindings('/app', current)).toEqual([]);
    const empty = {
      database: () => true,
      migrations: async () => [],
      ledger: () => expect.unreachable('no migration, so no ledger read'),
    };
    expect(await ledgerFindings('/app', empty)).toEqual([]);
    // No database in this process (a generation built by a test or a tool): nothing to compare.
    const none = { ...empty, database: () => false, migrations: async () => [posts] };
    expect(await ledgerFindings('/app', none)).toEqual([]);
  });

  test('schemaAheadFindings reports it beside a clean source check', async () => {
    const behind = async () => [
      { code: 'X_APP_MIGRATIONS_UNAPPLIED', cause: 'one behind', fix: 'x db migrate' },
    ];
    const findings = await schemaAheadFindings('/app', async () => [], behind);
    expect(findings.map((finding) => finding.code)).toEqual(['X_APP_MIGRATIONS_UNAPPLIED']);
  });
});
