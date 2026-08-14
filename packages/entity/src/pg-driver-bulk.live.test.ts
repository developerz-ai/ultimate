// The bulk write path against a real Postgres. `pg-driver-bulk.test.ts` asserts the statement text
// a batch compiles to; nothing there proves the server accepts a multi-row `insert`, that `default`
// in a cell resolves to the column's own DEFAULT, or that `on conflict` finds the unique index the
// framework's own migration wrote. Skips unless `TEST_DATABASE_URL` is set, as the live suite does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  setStatementObserver,
} from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

// `TEST_DATABASE_URL` only: `beforeAll`/`afterAll` here run `drop table … cascade`, so falling back
// to the app's own `DATABASE_URL` would hand this file whatever database a developer had exported.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_bulk_live_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

/**
 * `reference` is unique PER TENANT, and that is the shape an updating upsert forces: the conflict
 * target must carry the tenant column, so the constraint it is inferred against must too. A global
 * `unique()` on `reference` would make the cross-tenant case below unwritable in the first place.
 */
const invoices = entity('pg_bulk_live_invoices', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    reference: text({ max: 40 }),
    total: money(),
    paid: boolean().default(false),
    note: text().nullable(),
    issuedAt: timestamp().defaultNow(),
    deletedAt: timestamp().nullable(),
  },
  indexes: [{ on: ['orgId', 'reference'], unique: true }],
});

/** The other kind of unique index an upsert can land on: a composite primary key. */
const tags = entity('pg_bulk_live_tags', {
  columns: {
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    invoiceId: uuid().references(() => invoices.id, { onDelete: 'cascade' }),
    label: text({ max: 40 }),
    note: text().nullable(),
  },
  primaryKey: ['orgId', 'invoiceId', 'label'],
});

type Invoice = typeof invoices.$row;

const DROP =
  'drop table if exists "pg_bulk_live_tags", "pg_bulk_live_invoices", "pg_bulk_live_orgs" cascade';

const MONEY = { minor: 12_500, currency: 'EUR' };

const UNIQUE_INDEX = 'pg_bulk_live_invoices_org_id_reference_key';

/**
 * The generator returns one `up` script; a driver executes one statement. Splitting on `;\n` is
 * enough because every value in a generated clause is an identifier or a CHECK the entity wrote.
 */
const statementsOf = (script: string): readonly string[] =>
  script
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/**
 * A row that leaves columns out — which is what puts a `default` in its cell. `Repo` is typed for
 * whole rows, so the omission takes one assertion here; a batch assembled in JS arrives this way.
 */
const partial = (values: Partial<Invoice>): Invoice => values as Invoice;

describe.skipIf(!hasPostgres)('live · postgres · bulk writes', () => {
  let client: PostgresClient;
  let migration: ReturnType<typeof generateMigration>;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    migration = generateMigration({
      // Declaration order is dependency order: the foreign keys need their targets first.
      entities: [orgs.$describe(), invoices.$describe(), tags.$describe()],
      name: 'live bulk writes',
      now: new Date('2026-08-12T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) {
      await client.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  const db = () => database({ orgs, invoices, tags }, { driver: postgresDriver() });
  const repo = () => postgresRepo(invoices);

  /** A tenant nobody else wrote to, so a whole-tenant count is an assertion and not a race. */
  const newOrg = async (slug: string): Promise<string> =>
    (await database({ orgs }, { driver: postgresDriver() }).orgs.insert({ slug })).id;

  /** What a call produced, and how many statements against one table it took. */
  const counting = async <T>(match: string, work: () => Promise<T>): Promise<[T, number]> => {
    const seen: string[] = [];
    setStatementObserver({
      onStatement: (event) => {
        if (event.text.includes(match)) seen.push(event.text);
      },
    });
    try {
      return [await work(), seen.length];
    } finally {
      setStatementObserver(undefined);
    }
  };

  test('the server carries the unique constraints on conflict is inferred against', async () => {
    // The premise of every upsert below, asserted against the catalog rather than against a script:
    // both constraints are on this server, put there by the generated migration and nothing else.
    const indexes = await client.query<{ indexdef: string }>(
      raw(`select indexdef from pg_indexes where tablename = 'pg_bulk_live_invoices'`),
    );
    expect(indexes.some((index) => index.indexdef.includes('(org_id, reference)'))).toBe(true);
    expect(migration.up).toContain('primary key ("org_id", "invoice_id", "label")');
    // The composite index this file used to create by hand: the description carries its column
    // list, so the generator spells it whole instead of `("org_id_reference")` — a `42703`.
    expect(migration.up).toContain(
      `create unique index "${UNIQUE_INDEX}" on "pg_bulk_live_invoices" ("org_id", "reference");`,
    );
  });

  test('a batch round-trips through one multi-row insert', async () => {
    const org = await newOrg('bulk-insert');
    const batch = ['BULK-1', 'BULK-2', 'BULK-3'].map((reference) => ({
      orgId: org,
      reference,
      total: MONEY,
    }));

    const [written, sent] = await counting('insert into "pg_bulk_live_invoices"', () =>
      db().invoices.insertAll(batch),
    );

    // Three rows, one statement — the whole point of the call, against a server that counts.
    expect(sent).toBe(1);
    expect(written.map((row) => row.reference)).toEqual(['BULK-1', 'BULK-2', 'BULK-3']);
    for (const row of written) {
      // Every one of these came back from Postgres, not from the object that was passed in.
      expect(row.total).toEqual({ minor: 12_500, currency: 'EUR' });
      expect(row.paid).toBe(false);
      expect(row.note).toBeNull();
      expect(row.issuedAt).toBeInstanceOf(Date);
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await repo().count({ orgId: org })).toBe(3);
  });

  test('a row that omits a column takes the DEFAULT the migration wrote for it', async () => {
    const org = await newOrg('bulk-default');
    const stamped = new Date('2020-03-04T05:06:07.000Z');
    const rows = [
      partial({ orgId: org, reference: 'DEF-named', total: MONEY, paid: false, issuedAt: stamped }),
      partial({ orgId: org, reference: 'DEF-omitted', total: MONEY, paid: false }),
    ];

    const [named, omitted] = await repo().insertAll(rows);

    // One column list for the statement, so the row that did not name `issued_at` says `default`
    // in that cell — and `default` there is the column's own `now()`, resolved by the server.
    expect(named?.issuedAt).toEqual(stamped);
    expect(omitted?.issuedAt).toBeInstanceOf(Date);
    expect(omitted?.issuedAt.getTime()).toBeGreaterThan(stamped.getTime());
    // Neither row named `id`, so the column is absent from the statement altogether and both keys
    // are the server's: a batch cannot make a generated key stop being generated.
    expect(named?.id).not.toBe(omitted?.id);
    expect(omitted?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a nothing upsert on a composite key inserts the new rows and leaves the stored one', async () => {
    const org = await newOrg('bulk-nothing');
    const invoice = await db().invoices.insert({ orgId: org, reference: 'TAG-1', total: MONEY });
    const tag = (label: string, note: string | null) => ({
      orgId: org,
      invoiceId: invoice.id,
      label,
      note,
    });
    await db().tags.insertAll([tag('urgent', 'first')]);

    const written = await db().tags.upsertAll(
      [tag('urgent', 'overwritten'), tag('archive', null), tag('review', null)],
      { onConflict: ['orgId', 'invoiceId', 'label'], onMatch: 'nothing' },
    );

    // `returning *` names only the rows the server inserted, so the collision is absent from it.
    expect(written.map((row) => row.label).sort()).toEqual(['archive', 'review']);
    expect(await db().tags.where({ orgId: org }).count()).toBe(3);
    expect((await db().tags.where({ orgId: org, label: 'urgent' }).one())?.note).toBe('first');
  });

  test('an update upsert keeps the stored key and cannot reach another tenant', async () => {
    const org = await newOrg('bulk-update');
    const other = await newOrg('bulk-update-other');
    const stored = await db().invoices.insert({ orgId: org, reference: 'UP-1', total: MONEY });
    // The SAME reference under another tenant — legal, because the constraint is per tenant. This
    // is the row a target of `['reference']` alone would have matched, overwritten and taken.
    const theirs = await db().invoices.insert({ orgId: other, reference: 'UP-1', total: MONEY });
    const incoming = '00000000-0000-7000-8000-0000000000ff';

    const [written] = await db().invoices.upsertAll(
      [
        {
          id: incoming,
          orgId: org,
          reference: 'UP-1',
          total: { minor: 900, currency: 'GBP' },
          note: 'settled',
          paid: true,
        },
      ],
      { onConflict: ['orgId', 'reference'] },
    );

    // The stored row's address survives the write: every foreign key pointing at it still hits it,
    // and the id the caller happened to generate is not where the row moved to.
    expect(written?.id).toBe(stored.id);
    expect(written?.id).not.toBe(incoming);
    expect(written?.note).toBe('settled');
    expect(written?.paid).toBe(true);
    expect(written?.total).toEqual({ minor: 900, currency: 'GBP' });
    // One row, not two: the upsert landed on the stored one rather than beside it.
    expect(await repo().count({ orgId: org })).toBe(1);

    // And the other tenant's row is byte-for-byte what it was — same id, same values, still theirs.
    expect(await repo().findById(theirs.id, { orgId: other })).toEqual(theirs);
    expect(await repo().count({ orgId: other })).toBe(1);
  });

  test('a soft-deleted row still occupies its unique key, so an upsert collides with it', async () => {
    const org = await newOrg('bulk-soft');
    const stored = await db().invoices.insert({ orgId: org, reference: 'SOFT-1', total: MONEY });
    await repo().delete(stored.id, { orgId: org });

    const written = await db().invoices.upsertAll(
      [{ orgId: org, reference: 'SOFT-1', total: MONEY }],
      { onConflict: ['orgId', 'reference'], onMatch: 'nothing' },
    );

    // The unique index is not partial, so a hidden row still owns `reference`: the insert collides,
    // writes nothing, and never becomes a second row the app can no longer read.
    expect(written).toEqual([]);
    expect(await repo().findById(stored.id, { orgId: org })).toBeNull();

    // One row, still stamped: the collision neither resurrected it nor sat down beside it.
    const hidden = await repo().findMany({ orgId: org, includeDeleted: true });
    expect(hidden.rows).toHaveLength(1);
    expect(hidden.rows[0]?.id).toBe(stored.id);
    expect(hidden.rows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  test('an update upsert onto that stamped row writes its columns and never its stamp', async () => {
    const org = await newOrg('bulk-soft-update');
    const stored = await db().invoices.insert({
      orgId: org,
      reference: 'SOFT-2',
      total: MONEY,
      note: 'before',
    });
    await repo().delete(stored.id, { orgId: org });

    // The row the caller passes carries `deletedAt: null` whether they wrote it or not — `$parse`
    // fills every declared column — so this is the shape that would resurrect it.
    const [written] = await db().invoices.upsertAll(
      [{ orgId: org, reference: 'SOFT-2', total: MONEY, note: 'after' }],
      { onConflict: ['orgId', 'reference'] },
    );

    // `"deleted_at"` is not in the `do update set` list: the delete the app made stands, and the
    // row is still invisible to an ordinary read.
    expect(written?.note).toBe('after');
    expect(written?.deletedAt).toBeInstanceOf(Date);
    expect(await repo().findById(stored.id, { orgId: org })).toBeNull();
    expect(await repo().count({ orgId: org })).toBe(0);
  });
});
