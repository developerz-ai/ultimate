// Single responsibility: the advisory lock in migrate.ts against a real Postgres. A recording
// client cannot distinguish "every statement ran on the session that took the lock" from "the
// lock landed on whichever connection the pool lent for one statement" — the two produce
// identical statement text and only Postgres' own lock bookkeeping tells them apart. Skips unless
// `TEST_DATABASE_URL` is set, the same convention as `pg-driver.live.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import { diffSchema } from './drift';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './generate';
import { generateMigration } from './generate';
import { introspect, type SchemaDescription } from './introspect';
import { LEDGER_TABLE, type Migration, migrate, rollback } from './migrate';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · migrate advisory lock', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '' });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    await freshClient().execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  });

  afterEach(async () => {
    // Closing every pool ends its backends — which is exactly what makes a broken unlock (landed
    // on the wrong session) visible: the lock only ever clears here, never on its own, so a test
    // that left one stuck would wedge every test after it instead of just failing this one.
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  const slowMigration: Migration = {
    id: '20260101000000_live_lock_probe',
    name: 'live lock probe',
    up: 'select pg_sleep(0.3)',
    down: 'select 1',
  };

  test('two concurrent migrate() calls serialize: one applies, the other skips, never both', async () => {
    // Two independent pools, standing in for two migrator processes — a deploy's rolling
    // restart, not two callers sharing one pinned connection by accident.
    const a = freshClient();
    const b = freshClient();
    const started = performance.now();

    const [first, second] = await Promise.all([
      migrate({ migrations: [slowMigration], client: a }),
      migrate({ migrations: [slowMigration], client: b }),
    ]);

    // A broken lock lets both callers read an empty ledger before either commits, and both
    // then try to insert the same primary key — this `Promise.all` rejecting with a
    // unique-violation is exactly what that looks like, and either report double-counting
    // `applied` is the same race without the crash.
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(280);

    const reports = [first, second];
    const applied = reports.filter((report) => report.applied.length === 1);
    const skipped = reports.filter((report) => report.skipped.length === 1);
    expect(applied).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(applied[0]?.applied[0]?.id).toBe(slowMigration.id);
    expect(skipped[0]?.skipped[0]).toBe(slowMigration.id);
  }, 15_000);

  test('the lock is released after a migration fails, so the next migrate() does not hang', async () => {
    const broken: Migration = {
      id: '20260101000100_live_lock_failure',
      name: 'broken up sql',
      up: 'this is not sql',
      down: 'select 1',
    };

    await expect(migrate({ migrations: [broken], client: freshClient() })).rejects.toThrow();

    // If the unlock landed on a session other than the one that took the lock — the defect
    // the pin closes — the true holder sits idle in the pool still holding it, and this
    // second call blocks until that connection's idle timeout fires instead of finishing in
    // ~0.3s.
    const startedSecond = performance.now();
    const report = await migrate({ migrations: [slowMigration], client: freshClient() });
    const elapsedMs = performance.now() - startedSecond;

    expect(report.applied.map((applied) => applied.id)).toEqual([slowMigration.id]);
    expect(elapsedMs).toBeLessThan(3_000);
  }, 15_000);
});

/**
 * The one thing a recording client cannot answer: whether a server accepts what the migrator sends.
 * The refusal itself is the embedded driver's — `pglite-embedded.test.ts` holds that case, because
 * PGlite is the extended protocol always — and what belongs here is the other half: the same split
 * script, applied and reversed against a real server, in the order the script wrote it.
 */
describe.skipIf(!hasPostgres)('live · postgres · migrate applies a script', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '' });
    clients.push(client);
    return client;
  };

  const script: Migration = {
    id: '20260101000200_live_script',
    name: 'live script',
    // What `generateMigration` emits for one indexed entity, plus the note it leaves for a NOT
    // NULL column added later — a `;` inside a comment, which is not a separator.
    up:
      'create table "live_script_posts" ("id" uuid primary key, "org_id" uuid not null);\n' +
      'create index "live_script_posts_org_id_idx" on "live_script_posts" ("org_id");\n' +
      '-- backfill "org_id", then: alter table "live_script_posts" alter column "org_id" ' +
      'set not null;\n',
    down: 'drop index "live_script_posts_org_id_idx";\ndrop table "live_script_posts";',
  };

  beforeEach(async () => {
    const client = freshClient();
    await client.execute(raw('drop table if exists "live_script_posts" cascade'));
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test('a table and its index in one up apply, and rollback reverses both', async () => {
    const report = await migrate({ migrations: [script], client: freshClient() });
    expect(report.applied.map((applied) => applied.id)).toEqual([script.id]);

    const client = freshClient();
    const indexes = await client.query<{ indexname: string }>(
      raw(`select indexname from pg_indexes where tablename = 'live_script_posts'`),
    );
    expect(indexes.map((row) => row.indexname)).toContain('live_script_posts_org_id_idx');

    const reverted = await rollback({ migrations: [script], client: freshClient() });
    expect(reverted).toEqual([script.id]);
    const after = await freshClient().query<{ n: number }>(
      raw(`select count(*)::int as n from pg_tables where tablename = 'live_script_posts'`),
    );
    expect(after[0]?.n).toBe(0);
  }, 15_000);
});

/** Entity-description builders, shared by the two generated-migration describes below. */
const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const index = (
  name: string,
  columns: readonly string[],
  overrides: Partial<IndexDescriptionLike> = {},
): IndexDescriptionLike => ({
  name,
  columns,
  unique: false,
  where: null,
  order: null,
  ...overrides,
});

/**
 * End to end, the way `x db gen` then `x db migrate` actually runs it: an entity description
 * through `generateMigration` — never hand-written SQL — applied by the real ledger engine,
 * `migrate()`, against a server. The bug `04c974f` fixed lived in the generator: a composite
 * index recovered its column list by parsing the index *name*, which does not run backwards
 * (`_` both joins columns and appears inside them), so two columns applied as
 * `("org_id_created_at")` — a column that does not exist, `42703`. Proving the generated SQL is
 * correct (`generate.test.ts`) and proving `migrate()` can apply a multi-statement script
 * (the test above) are each necessary and neither alone is the fix — this is the join of both,
 * the one path nothing else here exercises.
 */
describe.skipIf(!hasPostgres)('live · postgres · migrate applies a composite index', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '' });
    clients.push(client);
    return client;
  };

  const entity: EntityDescriptionLike = {
    name: 'LiveCompositePost',
    table: 'live_composite_posts',
    primaryKey: ['id'],
    columns: [
      column('id', { kind: 'uuid', notNull: true, primaryKey: true }),
      column('org_id', { kind: 'uuid', notNull: true }),
      column('created_at', { kind: 'timestamptz', notNull: true }),
    ],
    indexes: [
      index('live_composite_posts_org_id_created_at_idx', ['org_id', 'created_at']),
      index('live_composite_posts_org_id_id_key', ['org_id', 'id'], { unique: true }),
    ],
  };

  const generated = generateMigration({
    entities: [entity],
    name: 'live composite index',
    now: new Date('2026-08-14T00:00:00.000Z'),
  });
  // `generateMigration` is the same function `x db gen` calls — a hand-written `up`/`down` here
  // would test `migrate()` alone, which the plain script test above already covers.
  const composite: Migration = {
    id: generated.id,
    name: 'live composite index',
    up: generated.up,
    down: generated.down,
  };

  beforeEach(async () => {
    const client = freshClient();
    await client.execute(raw('drop table if exists "live_composite_posts" cascade'));
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test('a composite index and a composite unique index both apply, in full, and rollback drops them', async () => {
    // Never the collapsed `("org_id_created_at")` the name-parsing bug used to emit.
    expect(composite.up).toContain(
      'create index "live_composite_posts_org_id_created_at_idx" ' +
        'on "live_composite_posts" ("org_id", "created_at");',
    );
    expect(composite.up).toContain(
      'create unique index "live_composite_posts_org_id_id_key" ' +
        'on "live_composite_posts" ("org_id", "id");',
    );

    const report = await migrate({ migrations: [composite], client: freshClient() });
    expect(report.applied.map((applied) => applied.id)).toEqual([composite.id]);

    const client = freshClient();
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      raw(`select indexname, indexdef from pg_indexes where tablename = 'live_composite_posts'`),
    );
    const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));
    // The server's own catalog, not just the generated text — the columns really landed.
    expect(byName.get('live_composite_posts_org_id_created_at_idx')).toContain(
      '(org_id, created_at)',
    );
    expect(byName.get('live_composite_posts_org_id_id_key')).toContain('(org_id, id)');

    // The description `checkDrift` compares against, off the same server. Ordered by `indkey`
    // and not by `attnum`: a composite index whose columns are declared in a different order
    // from the table's came back reversed, which reads correct and compares wrong.
    const live = await introspect({ client });
    const described = live.tables.find((each) => each.name === 'live_composite_posts');
    const declared = new Map(described?.indexes.map((each) => [each.name, each]) ?? []);
    expect(declared.get('live_composite_posts_org_id_created_at_idx')?.columns).toEqual([
      'org_id',
      'created_at',
    ]);
    expect(declared.get('live_composite_posts_org_id_id_key')?.unique).toBe(true);

    // And this table, as the server holds it, matches the snapshot the migration wrote down —
    // through `diffSchema`, the comparison `checkDrift` runs. Scoped to the one table because a
    // shared test database carries every other suite's tables too.
    const snapshotTable = generated.snapshot.tables.find(
      (each) => each.name === 'live_composite_posts',
    );
    expect(
      diffSchema(
        { tables: described === undefined ? [] : [described] },
        { tables: snapshotTable === undefined ? [] : [snapshotTable] },
      ),
    ).toEqual({ ok: true, differences: [] });

    const reverted = await rollback({ migrations: [composite], client: freshClient() });
    expect(reverted).toEqual([composite.id]);
    const after = await freshClient().query<{ n: number }>(
      raw(`select count(*)::int as n from pg_tables where tablename = 'live_composite_posts'`),
    );
    expect(after[0]?.n).toBe(0);
  }, 15_000);
});

/**
 * The other half of a generated migration a snapshot has to carry: the foreign key. `snapshotOf`
 * recorded `foreignKeys: []` beside an `up` that emitted `references "…" ("id")` — a snapshot
 * denying a constraint its own migration creates — so `compareTable` had nothing to compare and a
 * key dropped on the database by hand was invisible to `x db migrate`'s post-migrate check. Only a
 * server answers this: the constraint's name, its columns and its target come from `pg_constraint`,
 * and dropping one is DDL a recording client cannot perform.
 */
describe.skipIf(!hasPostgres)('live · postgres · migrate applies a foreign key', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '' });
    clients.push(client);
    return client;
  };

  const orgs: EntityDescriptionLike = {
    name: 'LiveKeyOrg',
    table: 'live_key_orgs',
    primaryKey: ['id'],
    columns: [column('id', { kind: 'uuid', notNull: true, primaryKey: true })],
    indexes: [],
  };

  const posts: EntityDescriptionLike = {
    name: 'LiveKeyPost',
    table: 'live_key_posts',
    primaryKey: ['id'],
    columns: [
      column('id', { kind: 'uuid', notNull: true, primaryKey: true }),
      column('org_id', { kind: 'uuid', notNull: true, references: 'live_key_orgs.id' }),
    ],
    indexes: [index('live_key_posts_org_id_idx', ['org_id'])],
  };

  const generated = generateMigration({
    entities: [orgs, posts],
    name: 'live foreign key',
    now: new Date('2026-08-14T00:00:00.000Z'),
  });
  const withKey: Migration = {
    id: generated.id,
    name: 'live foreign key',
    up: generated.up,
    down: generated.down,
  };

  const scoped = (live: SchemaDescription, table: string): SchemaDescription => ({
    tables: live.tables.filter((each) => each.name === table),
  });

  beforeEach(async () => {
    const client = freshClient();
    await client.execute(raw('drop table if exists "live_key_posts" cascade'));
    await client.execute(raw('drop table if exists "live_key_orgs" cascade'));
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test('the key applies, matches its snapshot, and dropping it by hand is drift', async () => {
    const report = await migrate({ migrations: [withKey], client: freshClient() });
    expect(report.applied.map((applied) => applied.id)).toEqual([withKey.id]);

    const client = freshClient();
    const live = await introspect({ client });
    const described = live.tables.find((each) => each.name === 'live_key_posts');
    // The server's own catalog: the constraint the inline clause created, named as the snapshot
    // predicted and pointing where the entity said.
    expect(described?.foreignKeys).toEqual([
      {
        name: 'live_key_posts_org_id_fkey',
        columns: ['org_id'],
        referencedTable: 'live_key_orgs',
        referencedColumns: ['id'],
        onDelete: 'a',
      },
    ]);

    const expected = scoped(generated.snapshot, 'live_key_posts');
    expect(diffSchema(scoped(live, 'live_key_posts'), expected)).toEqual({
      ok: true,
      differences: [],
    });

    // The failure this exists for. `alter table … drop constraint` is exactly the hand edit
    // `checkDrift` is the last line against, and it used to report `ok: true`.
    await client.execute(
      raw('alter table "live_key_posts" drop constraint "live_key_posts_org_id_fkey"'),
    );
    const after = diffSchema(scoped(await introspect({ client }), 'live_key_posts'), expected);
    expect(after.ok).toBe(false);
    expect(after.differences[0]?.kind).toBe('missing-foreign-key');
    expect(after.differences[0]?.cause).toContain('no foreign key on (org_id) to "live_key_orgs"');

    // The same constraint under another name is the same constraint: drift matches on where the
    // key points, never on what a migration called it.
    await client.execute(
      raw(
        'alter table "live_key_posts" add constraint "fk_live_key_posts_org" ' +
          'foreign key ("org_id") references "live_key_orgs" ("id")',
      ),
    );
    expect(diffSchema(scoped(await introspect({ client }), 'live_key_posts'), expected).ok).toBe(
      true,
    );
  }, 15_000);
});
