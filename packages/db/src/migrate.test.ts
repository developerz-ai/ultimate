// Single responsibility: what `migrate()` and `rollback()` DO to the ledger — the forward path,
// the conflicts they refuse, the step count they validate, and how one script becomes one send per
// statement. Which session those statements run on is `migrate-pin.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { setDbClient } from './client';
import { createRecordingClient, type RecordingClient } from './fake';
import { type EntityDescriptionLike, generateMigration } from './generate';
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
    // Not `x db status --json`: that subcommand has never existed, and this is one of the two
    // errors most likely to fire during a real deploy.
    expect(error.fix).toContain('deploy app version "1.6.0"');
    expect(error.fix).toContain('psql "$DATABASE_URL"');

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

/**
 * One send is one statement — what the recording client can answer is the *shape*: how many sends
 * the migrator makes, in what order, and inside which transaction. Whether an engine accepts a
 * script is a different question and a fake has no opinion on it, so it is pinned against the real
 * embedded database in `pglite-embedded.test.ts` and a real server in `migrate.live.test.ts`.
 */
describe('a multi-statement migration', () => {
  const withIndex: EntityDescriptionLike = {
    name: 'Post',
    table: 'posts',
    primaryKey: ['id'],
    columns: [
      {
        property: 'id',
        column: 'id',
        kind: 'uuid',
        notNull: true,
        primaryKey: true,
        unique: false,
        hasDefault: true,
        check: null,
        references: null,
      },
      {
        property: 'orgId',
        column: 'org_id',
        kind: 'uuid',
        notNull: true,
        primaryKey: false,
        unique: false,
        hasDefault: false,
        check: null,
        references: null,
      },
    ],
    indexes: [
      { name: 'posts_org_id_idx', columns: ['org_id'], unique: false, where: null, order: null },
    ],
  };

  const generated = (): Migration => {
    const migration = generateMigration({
      entities: [withIndex],
      name: 'create posts',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    return { id: migration.id, name: migration.name, up: migration.up, down: migration.down };
  };

  test('what `x db gen` writes for an indexed entity applies, one statement at a time', async () => {
    client.on(/from x_migrations/, { rows: [] });
    client.on('insert into x_migrations', { affected: 1 });
    const migration = generated();
    // The regression itself: what the generator produced was never applicable as one send.
    expect(migration.up).toContain('create table "posts"');
    expect(migration.up).toContain('create index "posts_org_id_idx"');

    const report = await migrate({ migrations: [migration], appVersion: '1.5.0', client });

    expect(report.applied).toHaveLength(1);
    // Two sends, in the script's order, and neither carries the other.
    const table = client.texts.findIndex((text) => text.startsWith('create table "posts"'));
    const index = client.texts.findIndex((text) => text.startsWith('create index'));
    expect(table).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(table);
    expect(client.texts[table]).not.toContain('create index');
    expect(client.texts[index]).not.toContain('create table');
    // Still one transaction: a half-applied migration is worse than an unapplied one.
    expect(client.texts.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(client.texts.filter((text) => text === 'COMMIT')).toHaveLength(1);
    expect(client.texts.indexOf('COMMIT')).toBeGreaterThan(index);
    expect(
      client.texts.findIndex((text) => text.includes('insert into x_migrations')),
    ).toBeGreaterThan(index);
  });

  test('a semicolon inside a literal is data, not a second statement', async () => {
    client.on(/from x_migrations/, { rows: [] });
    client.on('insert into x_migrations', { affected: 1 });
    const migration: Migration = {
      ...addPosts,
      up: `alter table "orgs" add constraint "c" check ("slug" ~ 'a;b');`,
    };

    await migrate({ migrations: [migration], appVersion: '1.5.0', client });

    expect(client.texts).toContain(`alter table "orgs" add constraint "c" check ("slug" ~ 'a;b')`);
  });

  test('a script with nothing to run sends nothing, and still records the ledger row', async () => {
    client.on(/from x_migrations/, { rows: [] });
    client.on('insert into x_migrations', { affected: 1 });
    // `generateMigration` answers `''` for a no-op, and its `-- backfill …;` note is a whole
    // chunk on its own. Either reaching a driver on the extended protocol is an empty query.
    const empty: Migration = { ...addPosts, up: '  \n-- nothing to do here\n' };

    const report = await migrate({ migrations: [empty], appVersion: '1.5.0', client });

    expect(report.applied).toHaveLength(1);
    // The lock timeout is the transaction's own guard, not the script's, so it is not counted.
    const inside = client.texts
      .slice(client.texts.indexOf('BEGIN') + 1, client.texts.indexOf('COMMIT'))
      .filter((text) => !text.includes('lock_timeout'));
    expect(inside).toHaveLength(1);
    expect(inside[0]).toContain('insert into x_migrations');
  });

  test('rollback splits the down script the same way', async () => {
    const migration: Migration = {
      ...addPosts,
      down: 'drop index "posts_org_id_idx";\ndrop table "posts";',
    };
    client.on(/from x_migrations/, {
      rows: [ledgerRow({ checksum: migrationChecksum(migration) })],
    });

    const reverted = await rollback({ migrations: [migration], client });

    expect(reverted).toEqual([migration.id]);
    expect(client.texts).toContain('drop index "posts_org_id_idx"');
    expect(client.texts).toContain('drop table "posts"');
    expect(client.texts.indexOf('drop table "posts"')).toBeGreaterThan(
      client.texts.indexOf('drop index "posts_org_id_idx"'),
    );
  });
});

/**
 * `steps` reaches `slice(0, steps)`, and a negative argument there is not "fewer" — it counts
 * from the END, so `-1` selects every row but the newest and reverses 4 of 5 migrations. A
 * rollback is the one operation whose mistakes are unrecoverable, so the count is validated
 * before the lock is taken and before the ledger is read.
 */
describe('rollback validates its step count', () => {
  const fiveRows = (): readonly LedgerRow[] =>
    ['a', 'b', 'c', 'd', 'e'].map((suffix, index) =>
      ledgerRow({ id: `2026010100000${index}_${suffix}` }),
    );

  const migrationsFor = (rows: readonly LedgerRow[]): readonly Migration[] =>
    rows.map((row) => ({ ...addPosts, id: row.id, name: row.id }));

  // "Refused" alone is satisfied by a check that runs AFTER the lock and the ledger read, which is
  // exactly the placement the fix exists to rule out — so each refusal also asserts that neither
  // statement went out. Returns the offenders, so a failure names the statement that escaped.
  const statementsBeforeTheRefusal = (): readonly string[] =>
    client.texts.filter(
      (text) => text.includes('pg_try_advisory_lock') || text.includes('from x_migrations'),
    );

  test('a negative step count is refused, not read as "all but the newest"', async () => {
    const rows = fiveRows();
    client.on(/from x_migrations/, { rows: [...rows] });

    const caught = await rollback({ migrations: migrationsFor(rows), steps: -1 }).catch(
      (error: unknown) => error,
    );

    expect((caught as { code: string }).code).toBe('X_INVARIANT');
    expect((caught as { cause: string }).cause).toContain('-1');
    expect((caught as { fix: string }).fix).toContain('rollback(');
    // Nothing was reversed, and the lock was never taken nor the ledger read.
    expect(client.texts.some((text) => text.includes('drop table'))).toBe(false);
    expect(client.texts.some((text) => text.includes('delete from x_migrations'))).toBe(false);
    expect(statementsBeforeTheRefusal()).toEqual([]);
  });

  test('zero is refused too — a rollback that reverses nothing is a typo, not an intent', async () => {
    const rows = fiveRows();
    client.on(/from x_migrations/, { rows: [...rows] });

    const caught = await rollback({ migrations: migrationsFor(rows), steps: 0 }).catch(
      (error: unknown) => error,
    );

    expect((caught as { code: string }).code).toBe('X_INVARIANT');
    expect(statementsBeforeTheRefusal()).toEqual([]);
  });

  test('a fractional step count is refused rather than truncated', async () => {
    const rows = fiveRows();
    client.on(/from x_migrations/, { rows: [...rows] });

    const caught = await rollback({ migrations: migrationsFor(rows), steps: 1.5 }).catch(
      (error: unknown) => error,
    );

    expect((caught as { code: string }).code).toBe('X_INVARIANT');
    expect(statementsBeforeTheRefusal()).toEqual([]);
  });

  test('a positive integer still reverses exactly that many, newest first', async () => {
    const rows = fiveRows();
    client.on(/from x_migrations/, { rows: [...rows] });

    const reverted = await rollback({ migrations: migrationsFor(rows), steps: 2 });

    expect(reverted).toEqual(['20260101000004_e', '20260101000003_d']);
  });
});

/**
 * The audit's question is "does this build ship every migration the ledger records?", and the
 * version is the ANSWER's detail, never part of the question. Gating on `app_version !==
 * appVersion` made the audit blind in exactly the environment that deletes migrations: every
 * development build resolves to `dev` (`runningAppVersion()`), so a migration applied by an
 * earlier `dev` build and since deleted passed the audit, and `expectedSchema` then filtered its
 * table out of the drift comparison — `ok: true` against a database that still has the table.
 */
describe('auditLedger refuses a migration this build does not ship', () => {
  const gone = ledgerRow({ id: '20260202000000_deleted', app_version: 'dev' });

  test('even when the row was applied by a build naming the same version', () => {
    let thrown: unknown;
    try {
      auditLedger([gone], [addPosts], 'dev');
    } catch (error) {
      thrown = error;
    }

    const error = thrown as { code: string; cause: string; fix: string };
    expect(error.code).toBe('X_MIGRATION_CONFLICT');
    expect(error.cause).toContain('20260202000000_deleted');
    // The version moved into the cause; it is still the fact an operator acts on.
    expect(error.cause).toContain('"dev"');
    expect(error.fix).toContain("delete from x_migrations where id = '20260202000000_deleted'");
  });

  test('a ledger this build ships in full still passes', () => {
    expect(() => auditLedger([ledgerRow()], [addPosts], 'dev')).not.toThrow();
  });
});
