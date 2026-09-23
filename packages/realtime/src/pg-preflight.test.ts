// The four questions asked of a database before `START_REPLICATION`: `wal_level`, the publication,
// every entity's replica identity and the slot — in that order, because the identity check is
// worthless once the slot exists. Split from `pg-replication.test.ts` at the 500-line ceiling.
import { describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { PgLogicalReplicationFeed } from './changefeed';
import { start } from './pg-replication-fixture';

describe('PgLogicalReplicationFeed', () => {
  test('an empty entity list is refused before a socket is opened', () => {
    expect(
      () =>
        new PgLogicalReplicationFeed({
          url: 'postgres://x@y/z',
          slot: 's',
          publication: 'p',
          entities: [],
        }),
    ).toThrow(/empty entity list/);
  });

  test('preflights wal_level, the publication and the slot before it streams', async () => {
    const { server, feed } = await start();
    expect(server.queries[0]).toBe('SHOW wal_level');
    expect(server.queries[1]).toContain('pg_publication');
    expect(server.queries[2]).toContain('relreplident');
    expect(server.queries[3]).toContain('pg_replication_slots');
    expect(server.queries[4]).toStartWith('START_REPLICATION SLOT ultimate_slot LOGICAL 0/0');
    expect(server.queries[4]).toContain("publication_names 'ultimate_pub'");
    await feed.stop();
  });

  test('creates the slot when there is none, and never touches an existing one', async () => {
    const fresh = await start({ script: { slotPlugin: null } });
    expect(fresh.server.queries[4]).toBe(
      "SELECT pg_create_logical_replication_slot('ultimate_slot', 'pgoutput')",
    );
    await fresh.feed.stop();

    const existing = await start();
    expect(existing.server.queries.some((sql) => sql.includes('pg_create'))).toBe(false);
    await existing.feed.stop();
  });

  // `ALTER SYSTEM` is refused on managed and operator-run Postgres, where the setting lives in the
  // provider's configuration — so the fix names the setting and where it goes, never that command.
  test('a non-logical wal_level names the setting and the restart, never ALTER SYSTEM', async () => {
    const failure = await start({ script: { walLevel: 'replica' } }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    const fix = (failure as { fix?: string }).fix ?? '';
    expect(fix).toContain('wal_level=logical');
    expect(fix).toContain('restart');
    expect(fix).not.toContain('ALTER SYSTEM');
  });

  // `FOR ALL TABLES` needs a superuser, which a managed database never hands an app role; the
  // publication an app needs is exactly its entities' tables. And streaming needs the REPLICATION
  // role attribute, which no fix line ever named.
  test('a missing publication is created FOR the entity tables, and names the role attribute', async () => {
    const noPublication = await start({ script: { publicationExists: false } }).catch(
      (error: unknown) => error,
    );
    const fix = (noPublication as { fix?: string }).fix ?? '';
    expect(fix).toStartWith('CREATE PUBLICATION ultimate_pub FOR TABLE posts;');
    expect(fix).not.toContain('FOR ALL TABLES');
    expect(fix).toContain('ALTER ROLE "replicator" WITH REPLICATION;');
  });

  test('a foreign slot plugin carries its own fix', async () => {
    const wrongPlugin = await start({ script: { slotPlugin: 'wal2json' } }).catch(
      (error: unknown) => error,
    );
    expect((wrongPlugin as { fix?: string }).fix).toContain('pg_drop_replication_slot');
  });

  // A live query decides "did this row leave the result set" from `change.before`, and under any
  // replica identity but FULL that tuple is the key columns alone — which `toRow` accepts, because
  // it only requires a text `id`. Nothing emitted `REPLICA IDENTITY FULL` and nothing checked for
  // it: the only two occurrences in the tree were a hand-written migration and a live test.
  test('a table that is not REPLICA IDENTITY FULL is named, with the ALTER that fixes it', async () => {
    const warn = spyOn(logger, 'warn');
    const { feed, server } = await start({ script: { partialIdentity: ['posts'] } });
    const line = warn.mock.calls.find((call) => call[0] === 'X_LIVE_REPLICA_IDENTITY');
    warn.mockRestore();
    await feed.stop();

    expect(line?.[1]).toMatchObject({ tables: ['posts'] });
    expect(String(line?.[1]?.['fix'])).toContain('ALTER TABLE posts REPLICA IDENTITY FULL;');
    expect(String(line?.[1]?.['cause'])).toContain('partial row');
    // Before the slot is created, because changing the identity afterwards does not reach a slot
    // that already exists — the check is worthless anywhere later in the sequence.
    const asked = server.queries.findIndex((sql) => sql.includes('relreplident'));
    const created = server.queries.findIndex((sql) => sql.includes('pg_replication_slots'));
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(asked).toBeLessThan(created);
  });

  test('a fleet that is entirely FULL is warned about nothing', async () => {
    const warn = spyOn(logger, 'warn');
    const { feed } = await start();
    const line = warn.mock.calls.find((call) => call[0] === 'X_LIVE_REPLICA_IDENTITY');
    warn.mockRestore();
    await feed.stop();

    expect(line).toBeUndefined();
  });

  test('an identifier outside [a-z_][a-z0-9_]* never reaches a replication command', async () => {
    const failure = await start({ entities: ["posts'; drop table users --"] }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
  });
});
