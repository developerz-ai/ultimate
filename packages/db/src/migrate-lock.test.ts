// Single responsibility: the migration lock's two bounds — how long a migrator waits for the
// advisory lock before refusing, and how long a migration's own statements wait for a table lock.
// Both exist because a deploy that hangs is worse than a deploy that fails: the pod stays
// `Running`, the logs stay empty, and `backoffLimit` never fires.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DbClient, setDbClient } from './client';
import { expectedQueryLoopReason } from './expected-loop';
import { createRecordingClient, type RecordingClient } from './fake';
import {
  auditLedger,
  type LedgerRow,
  type Migration,
  migrate,
  migrationChecksum,
  rollback,
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

describe('the migration lock is bounded, not waited on', () => {
  /** A client whose lock answers `false` for the first `n` polls, then `true`. */
  function contendedFor(
    inner: RecordingClient,
    polls: number,
  ): { client: DbClient; seen: () => number } {
    let seen = 0;
    const client: DbClient = {
      query: (fragment) => inner.query(fragment),
      execute: (fragment) => inner.execute(fragment),
      one: async <T>(fragment: Parameters<DbClient['one']>[0]) => {
        const answer = await inner.one<T>(fragment);
        if (!fragment.text.includes('pg_try_advisory_lock')) return answer;
        seen += 1;
        return { locked: seen > polls } as T;
      },
    };
    return { client, seen: () => seen };
  }

  test('a lock nobody releases fails the deploy instead of hanging it', async () => {
    // `pg_advisory_lock` blocks with no timeout: a predecessor OOM-killed on a partition kept the
    // lock for hours while `helm upgrade --wait` sat inside one statement printing nothing, and
    // because the job never failed, `backoffLimit` never fired.
    client.on(/pg_try_advisory_lock/, { rows: [{ locked: false }] });
    client.on(/from x_migrations/, { rows: [] });

    const caught = (await migrate({
      migrations: [addPosts],
      appVersion: '1.5.0',
      lockWaitMs: 0,
    }).catch((error: unknown) => error)) as { code: string; cause: string; fix: string };

    expect(caught.code).toBe('X_MIGRATE_CONCURRENT');
    expect(caught.cause).toContain('4919202607');
    expect(caught.fix).toContain('pg_terminate_backend');
    // Nothing was applied, and nothing was unlocked that was never locked.
    expect(client.texts.some((text) => text.includes('create table "posts"'))).toBe(false);
    expect(client.texts.some((text) => text.includes('pg_advisory_unlock'))).toBe(false);
  });

  test('a lock held briefly is polled until it frees, then the migration runs', async () => {
    client.on(/from x_migrations/, { rows: [] });
    const contended = contendedFor(client, 2);

    const report = await migrate({
      migrations: [addPosts],
      appVersion: '1.5.0',
      client: contended.client,
      lockWaitMs: 5_000,
    });

    expect(report.applied.map((entry) => entry.id)).toEqual([addPosts.id]);
    expect(contended.seen()).toBe(3);
  });

  test('the poll declares itself, so a diagnostic does not report it as an N+1', async () => {
    client.on(/pg_try_advisory_lock/, { rows: [{ locked: false }] });
    const reasons: (string | undefined)[] = [];
    const watching: DbClient = {
      query: (fragment) => client.query(fragment),
      execute: (fragment) => client.execute(fragment),
      one: async <T>(fragment: Parameters<DbClient['one']>[0]) => {
        reasons.push(expectedQueryLoopReason());
        return client.one<T>(fragment);
      },
    };

    await migrate({ migrations: [addPosts], client: watching, lockWaitMs: 0 }).catch(
      () => undefined,
    );

    expect(reasons[0]).toContain('polled, not waited on');
  });
});

describe('lock_timeout', () => {
  test('every migration sets one, before the first statement of its up', async () => {
    // `alter table … add column` takes ACCESS EXCLUSIVE. A long SELECT holding ACCESS SHARE makes
    // it wait, and Postgres' lock queue is FIFO, so every later query on that table waits too —
    // with `statement_timeout = 0` on the migrate role, forever.
    client.on(/from x_migrations/, { rows: [] });

    await migrate({ migrations: [addPosts], appVersion: '1.5.0' });

    const order = client.texts;
    expect(order).toContain('SET LOCAL lock_timeout = 3000');
    expect(order.indexOf('SET LOCAL lock_timeout = 3000')).toBeGreaterThan(order.indexOf('BEGIN'));
    expect(order.indexOf('SET LOCAL lock_timeout = 3000')).toBeLessThan(
      order.findIndex((text) => text.includes('create table "posts"')),
    );
  });

  test('rollback bounds its own lock wait too', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow()] });

    await rollback({ migrations: [addPosts] });

    expect(client.texts).toContain('SET LOCAL lock_timeout = 3000');
  });

  test('0 disables it, and sends no statement at all', async () => {
    client.on(/from x_migrations/, { rows: [] });

    await migrate({ migrations: [addPosts], appVersion: '1.5.0', lockTimeoutMs: 0 });

    expect(client.texts.some((text) => text.includes('lock_timeout'))).toBe(false);
  });
});

describe('the deploy-critical fixes name commands that exist', () => {
  // `x db status` has never been a subcommand — gen, migrate, reset, studio, branch, backfill are.
  // These are the two errors most likely to fire during a real deploy, and axiom 4 is that an
  // error is an instruction.
  test('a foreign ledger row points at the version to deploy and the row to drop', () => {
    const foreign = ledgerRow({ id: '20260202000000_from_the_future', app_version: '1.6.0' });

    try {
      auditLedger([foreign], [addPosts], '1.5.0');
      expect.unreachable();
    } catch (error) {
      const fix = (error as { fix: string }).fix;
      expect(fix).not.toContain('x db status');
      expect(fix).not.toContain('roll the ledger');
      expect(fix).toContain('1.6.0');
      expect(fix).toContain('delete from x_migrations');
    }
  });

  test('a rollback of an unknown id points at the ledger read that names its build', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow({ id: '20260303000000_gone' })] });

    const caught = (await rollback({ migrations: [addPosts] }).catch(
      (error: unknown) => error,
    )) as { code: string; fix: string };

    expect(caught.code).toBe('X_MIGRATION_CONFLICT');
    expect(caught.fix).not.toContain('x db status');
    expect(caught.fix).toStartWith('psql "$DATABASE_URL"');
  });
});
