// Single responsibility: WHERE a migration's statements run — the advisory lock, the transaction
// and the DDL all on ONE pinned session, and the loop that declares itself to an N+1 detector.
// Split from `migrate.test.ts` for the file-size ceiling; `migrate-lock.test.ts` is the lock's
// other half, how long a migrator waits for it and what a statement's own lock wait is bounded to.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DbClient, type DbConnection, type ReservableClient, setDbClient } from './client';
import { expectedQueryLoopReason } from './expected-loop';
import { createRecordingClient, type RecordingClient } from './fake';
import { type LedgerRow, type Migration, migrate, migrationChecksum, rollback } from './migrate';

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

describe('the migration advisory lock', () => {
  test('the lock, the migration and the unlock run on one pinned session', async () => {
    client.on(/from x_migrations/, { rows: [] });
    const pool = pinnable(client);

    await migrate({ migrations: [addPosts], appVersion: '1.5.0', client: pool.client });

    expect(pool.events[0]).toBe('reserve');
    expect(pool.events[1]).toContain('pg_try_advisory_lock');
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
    expect(pool.events[1]).toContain('pg_try_advisory_lock');
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

/**
 * `lock` is a shipped, exported option with no shipped caller: `x db branch` — which both doc
 * comments named — does not pass it, and the only passers in the repo are the tests above. A
 * comment naming a caller that does not exist sends a reader to read that caller, and
 * `wiki/Migrations-And-Behaviour` already states the truth, so source and docs disagreed.
 *
 * Not deletable, which is why this is a pin and not a removal: it is public API shipped in 3.0.0,
 * and the "no pin was taken" assertions above would become unwritable without it.
 */
describe('the `lock` option documents what it is for, not a caller it does not have', () => {
  const source = async (): Promise<string> => Bun.file(`${import.meta.dir}/migrate.ts`).text();

  test('neither comment attributes the option to a command', async () => {
    expect(await source()).not.toContain('Only `x db branch` does this');
  });

  test('both comments say what makes a database private', async () => {
    const declarations = (await source()).match(/Skip the advisory lock[^*]*/g) ?? [];
    expect(declarations).toHaveLength(2);
    for (const declaration of declarations) {
      expect(declaration).toContain('branch');
      expect(declaration).toContain('test');
    }
  });

  test('and this package ships no caller that passes it', async () => {
    // The claim, enforced where it can be: a source file here that starts passing `lock` makes
    // the comment false again, and the failure names the file to re-word it with.
    const passers: string[] = [];
    for await (const path of new Bun.Glob('*.ts').scan({ cwd: import.meta.dir })) {
      if (path.endsWith('.test.ts')) continue;
      const text = await Bun.file(`${import.meta.dir}/${path}`).text();
      if (/\block:\s*(false|true)/.test(text)) passers.push(path);
    }
    expect(passers).toEqual([]);
  });
});
