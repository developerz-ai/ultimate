import { beforeEach, describe, expect, test } from 'bun:test';
import { type DbClient, type DbConnection, type ReservableClient, setDbClient } from './client';
import { expectedQueryLoopReason } from './expected-loop';
import { createRecordingClient, type RecordingClient } from './fake';
import {
  auditLedger,
  type LedgerRow,
  type Migration,
  migrate,
  migrationChecksum,
  pendingMigrations,
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

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface PinnablePool {
  readonly client: ReservableClient;
  /** `reserve`, `release`, and every statement tagged with the handle that ran it. */
  readonly events: readonly string[];
}

/**
 * A pool whose pin is observable. The defect this pins is invisible to the recording client: the
 * statement texts are identical whether the lock landed on the session that runs the migration or
 * on whatever connection the pool lent for that one statement, and only the tag says which.
 */
function pinnable(inner: DbClient): PinnablePool {
  const events: string[] = [];
  const through = (tag: string): DbClient => ({
    query: (fragment) => {
      events.push(`${tag}:${squash(fragment.text)}`);
      return inner.query(fragment);
    },
    one: (fragment) => {
      events.push(`${tag}:${squash(fragment.text)}`);
      return inner.one(fragment);
    },
    execute: (fragment) => {
      events.push(`${tag}:${squash(fragment.text)}`);
      return inner.execute(fragment);
    },
  });
  return {
    events,
    client: {
      ...through('pool'),
      reserve: async (): Promise<DbConnection> => {
        events.push('reserve');
        let held = true;
        const release = (): void => {
          if (!held) return;
          held = false;
          events.push('release');
        };
        return { ...through('pin'), release, [Symbol.dispose]: release };
      },
    },
  };
}

interface Witness {
  readonly client: DbClient;
  readonly statements: readonly { readonly text: string; readonly reason: string | undefined }[];
}

/**
 * Every statement paired with the `expectedQueryLoop` reason in force when it was issued. The
 * recording client cannot answer this: it never passes a funnel, so the observer never fires and
 * the scope has to be read where the statement is sent.
 */
function witnessed(inner: DbClient): Witness {
  const statements: { text: string; reason: string | undefined }[] = [];
  const note = (text: string): void => {
    statements.push({ text: squash(text), reason: expectedQueryLoopReason() });
  };
  return {
    statements,
    client: {
      query: (fragment) => {
        note(fragment.text);
        return inner.query(fragment);
      },
      one: (fragment) => {
        note(fragment.text);
        return inner.one(fragment);
      },
      execute: (fragment) => {
        note(fragment.text);
        return inner.execute(fragment);
      },
    },
  };
}

/**
 * Fails when nothing matched instead of answering `undefined` for it. `find(...)?.reason` alone
 * collapses two different facts into one value — "this statement ran outside every scope" and
 * "this statement never ran" — and the `toBeUndefined()` assertions below are the load-bearing
 * half of both test names, so a reworded ledger read would leave them passing on the wrong one.
 */
const reasonFor = (witness: Witness, needle: string): string | undefined => {
  expect(witness.statements.map((statement) => statement.text).join(' | ')).toContain(needle);
  return witness.statements.find((statement) => statement.text.includes(needle))?.reason;
};

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

describe('the migration advisory lock', () => {
  test('the lock, the migration and the unlock run on one pinned session', async () => {
    client.on(/from x_migrations/, { rows: [] });
    const pool = pinnable(client);

    await migrate({ migrations: [addPosts], appVersion: '1.5.0', client: pool.client });

    expect(pool.events[0]).toBe('reserve');
    expect(pool.events[1]).toContain('pg_advisory_lock');
    expect(pool.events.at(-2)).toContain('pg_advisory_unlock');
    expect(pool.events.at(-1)).toBe('release');
    // Not one statement on the pool: `pg_advisory_lock` is session-scoped, so work done on any
    // other connection is not under the lock, and the unlock would answer `false` on a session
    // that never took it. On `ROLE=migrate` (`max: 1`) there is no other connection to run on.
    expect(pool.events.filter((event) => event.startsWith('pool:'))).toEqual([]);
    expect(pool.events).toContain('pin:BEGIN');
    expect(pool.events).toContain('pin:COMMIT');
    expect(pool.events.some((event) => event.includes('create table "posts"'))).toBe(true);
    expect(pool.events.filter((event) => event === 'reserve')).toHaveLength(1);
  });

  test('a refused ledger unlocks and gives the pin back', async () => {
    const foreign = ledgerRow({ id: '20260202000000_from_the_future', app_version: '1.6.0' });
    client.on(/from x_migrations/, { rows: [foreign] });
    const pool = pinnable(client);

    await expect(
      migrate({ migrations: [addPosts], appVersion: '1.5.0', client: pool.client }),
    ).rejects.toThrow('X_MIGRATION_CONFLICT');

    expect(pool.events.at(-2)).toContain('pg_advisory_unlock');
    expect(pool.events.at(-1)).toBe('release');
  });

  test("lock: false takes no lock, and the only pin left is the transaction's own", async () => {
    client.on(/from x_migrations/, { rows: [] });
    const pool = pinnable(client);

    await migrate({
      migrations: [addPosts],
      appVersion: '1.5.0',
      client: pool.client,
      lock: false,
    });

    expect(client.texts.some((text) => text.includes('pg_advisory'))).toBe(false);
    // The ledger runs unpinned, so the one reservation belongs to `withTransaction`, not to a
    // lock scope that was never opened.
    expect(pool.events[0]).toStartWith('pool:');
    expect(pool.events.filter((event) => event === 'reserve')).toHaveLength(1);
    expect(pool.events.indexOf('reserve')).toBe(pool.events.indexOf('pin:BEGIN') - 1);
    expect(client.texts.some((text) => text.includes('create table "posts"'))).toBe(true);
  });

  test('rollback takes the same lock, on its own pinned session', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow()] });
    const pool = pinnable(client);

    const reverted = await rollback({ migrations: [addPosts], client: pool.client });

    expect(reverted).toEqual([addPosts.id]);
    expect(pool.events[0]).toBe('reserve');
    expect(pool.events[1]).toContain('pg_advisory_lock');
    expect(pool.events.some((event) => event.includes('drop table "posts"'))).toBe(true);
    expect(pool.events.filter((event) => event.startsWith('pool:'))).toEqual([]);
    expect(pool.events.at(-2)).toContain('pg_advisory_unlock');
    expect(pool.events.at(-1)).toBe('release');
  });

  test('a rollback that cannot reverse a row unlocks and gives the pin back', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow({ id: '20260404000000_unknown' })] });
    const pool = pinnable(client);

    await expect(rollback({ migrations: [addPosts], client: pool.client })).rejects.toThrow(
      'X_MIGRATION_CONFLICT',
    );

    expect(pool.events.some((event) => event.includes('drop table "posts"'))).toBe(false);
    expect(pool.events.at(-2)).toContain('pg_advisory_unlock');
    expect(pool.events.at(-1)).toBe('release');
  });

  // The framework's own deliberate loops declare themselves at source, so an N+1 detector reports
  // the ones nobody argued for. A migration per transaction is the point, not a batch to be found.
  test('the apply loop declares itself, and the ledger read before it does not', async () => {
    client.on(/from x_migrations/, { rows: [] });
    client.on('insert into x_migrations', { affected: 1 });
    const witness = witnessed(client);

    await migrate({
      migrations: [addPosts],
      appVersion: '1.5.0',
      client: witness.client,
      lock: false,
    });

    expect(reasonFor(witness, 'from x_migrations')).toBeUndefined();
    expect(reasonFor(witness, 'create table "posts"')).toContain('its own transaction');
    expect(reasonFor(witness, 'insert into x_migrations')).toContain('its own transaction');
  });

  test('the rollback loop declares itself too, with its own reason', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow()] });
    const witness = witnessed(client);

    await rollback({ migrations: [addPosts], client: witness.client, lock: false });

    expect(reasonFor(witness, 'from x_migrations')).toBeUndefined();
    expect(reasonFor(witness, 'drop table "posts"')).toContain('newest first');
    expect(reasonFor(witness, 'delete from x_migrations')).toContain('newest first');
  });

  test('rollback with lock: false takes no lock, for a private branch database', async () => {
    client.on(/from x_migrations/, { rows: [ledgerRow()] });
    const pool = pinnable(client);

    const reverted = await rollback({ migrations: [addPosts], client: pool.client, lock: false });

    expect(reverted).toEqual([addPosts.id]);
    expect(client.texts.some((text) => text.includes('pg_advisory'))).toBe(false);
    expect(pool.events[0]).toStartWith('pool:');
    expect(pool.events.filter((event) => event === 'reserve')).toHaveLength(1);
  });
});
