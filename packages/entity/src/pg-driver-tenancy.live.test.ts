// What a tenant column means against a real Postgres. `tenancy.test.ts` and
// `write-tenancy-parity.test.ts` prove the guard and the two drivers' agreement against a
// recording client; nothing there proves the ORG PREDICATE REACHES THE SERVER — that Postgres,
// not the process, is what refuses another tenant's row, and that a refused write never became a
// statement. Both halves of the guard are here: the plan a read builds, and the value a write
// carries.
//
// Its own tables, as every live file has: `beforeAll` runs `drop table … cascade`, so two files
// sharing a name would each destroy the other's schema. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_tenancy_live_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const invoices = entity('pg_tenancy_live_invoices', {
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
});

/**
 * A composite primary key AND a tenant column: the only rows `delete(id)` cannot address, so the
 * filtered writes are the only way to reach them — and the org predicate has to survive being one
 * of several filter columns rather than the whole filter.
 */
const invoiceTags = entity('pg_tenancy_live_invoice_tags', {
  columns: {
    invoiceId: uuid().references(() => invoices.id, { onDelete: 'cascade' }),
    label: text({ max: 40 }),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    note: text().nullable(),
  },
  primaryKey: ['invoiceId', 'label'],
});

type Invoice = typeof invoices.$row;

const DROP =
  'drop table if exists "pg_tenancy_live_invoice_tags", "pg_tenancy_live_invoices", ' +
  '"pg_tenancy_live_orgs" cascade';

describe.skipIf(!hasPostgres)('live · postgres · tenancy', () => {
  let client: PostgresClient;
  let acme = '';
  let other = '';

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      // Declaration order is dependency order: the foreign key needs the orgs table first.
      entities: [orgs.$describe(), invoices.$describe(), invoiceTags.$describe()],
      name: 'live tenancy',
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));

    const db = database({ orgs }, { driver: postgresDriver() });
    acme = (await db.orgs.insert({ slug: 'acme' })).id;
    other = (await db.orgs.insert({ slug: 'globex' })).id;
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  const db = () => database({ orgs, invoices }, { driver: postgresDriver() });
  const repo = () => postgresRepo(invoices);

  const write = (orgId: string, reference: string, patch: Partial<Invoice> = {}) =>
    db().invoices.insert({
      orgId,
      reference,
      total: { minor: 1000, currency: 'USD' },
      ...patch,
    });

  /**
   * A request, as production hands one over: a context whose actor carries the tenant, which is
   * where the guard takes it from. Copied rather than shared with `pg-driver.live.test.ts` — a
   * helper module could not be named `*.test.ts`, and `package.json` ships `src` minus its tests,
   * so a shared one would be published inside the tarball. Six test files in this package already
   * keep their own `caught`, three their own `inRequest`.
   */
  const inRequestFor = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
    runWithContext(createContext({ actor: userActor({ id: 'live-reader', orgId }) }), work);

  /** The stable code a call rejected with. Message text is not the contract; the code is. */
  const rejectionCode = async (call: Promise<unknown>): Promise<string> => {
    try {
      await call;
      return 'resolved';
    } catch (error) {
      return isUltimateError(error) ? error.code : String(error);
    }
  };

  test('tenancy is enforced on the row, not on the query shape', async () => {
    const written = await write(acme, 'INV-tenant');

    expect(await repo().findById(written.id, { orgId: acme })).not.toBeNull();
    // The id is correct and the row exists — only the tenant is wrong, and the statement itself
    // is what refuses it. Nothing in the process filters this after the fact.
    expect(await repo().findById(written.id, { orgId: other })).toBeNull();
    await expect(repo().update(written.id, { paid: true }, { orgId: other })).rejects.toThrow();
    await expect(repo().delete(written.id, { orgId: other })).rejects.toThrow();

    const stillThere = await repo().findById(written.id, { orgId: acme });
    expect(stillThere?.paid).toBe(false);
    expect(stillThere?.deletedAt).toBeNull();
  });

  test('a row written into another tenant never reaches the server', async () => {
    // The write half of the same rule, against a real table: `insert` builds no read plan, so
    // nothing bounds this but the row's own value — and the row is the caller's to write.
    const stolen = inRequestFor(acme, () =>
      db().invoices.insert({
        orgId: other,
        reference: 'INV-stolen',
        total: { minor: 1000, currency: 'USD' },
      }),
    );
    await expect(stolen).rejects.toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');

    // Refused before the statement, not undone after it: the row is not in the table, and the
    // count is taken outside the request so it is the table's answer and not the guard's.
    const named = { column: 'reference', op: 'eq' as const, value: 'INV-stolen' };
    expect(await repo().count({ orgId: other, where: [named] })).toBe(0);

    // The same value, named by a caller acting as that tenant, is an ordinary write.
    const theirs = await inRequestFor(other, () =>
      db().invoices.insert({
        orgId: other,
        reference: 'INV-theirs',
        total: { minor: 1000, currency: 'USD' },
      }),
    );
    expect(theirs.orgId).toBe(other);
  });

  test('a patch cannot hand a row to another tenant, and the row is untouched', async () => {
    const written = await write(acme, 'INV-move');
    const moved = inRequestFor(acme, () => repo().update(written.id, { orgId: other }));
    await expect(moved).rejects.toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');

    const stillOurs = await repo().findById(written.id, { orgId: acme });
    expect(stillOurs?.orgId).toBe(acme);
  });

  test('a composite-key row is deletable by filter, and only inside its own tenant', async () => {
    const tags = () => postgresRepo(invoiceTags);
    const mine = await write(acme, 'INV-tags');
    const yours = await write(other, 'INV-tags-other');
    const tag = (invoiceId: string, orgId: string, label: string) =>
      tags().insert({ invoiceId, orgId, label, note: null });

    for (const label of ['urgent', 'archive', 'review']) await tag(mine.id, acme, label);
    await tag(yours.id, other, 'urgent');

    // The whole point: three key columns' worth of row, none of them addressable by `delete(id)`.
    await expect(tags().delete(mine.id, { orgId: acme })).rejects.toThrow(/deleteWhere/);

    // A filter matching nothing is 0, not a throw and not a full-table delete.
    expect(await tags().deleteWhere({ invoiceId: mine.id, label: 'absent' }, { orgId: acme })).toBe(
      0,
    );
    expect(await tags().count({ orgId: acme })).toBe(3);

    // Exactly the row the full key names.
    expect(await tags().deleteWhere({ invoiceId: mine.id, label: 'urgent' }, { orgId: acme })).toBe(
      1,
    );
    expect(await tags().count({ orgId: acme })).toBe(2);

    // A partial filter takes the rest of this invoice's tags — and the other tenant's `urgent`
    // row matches the label but is behind the org predicate Postgres itself applies.
    expect(await tags().deleteWhere({ invoiceId: mine.id }, { orgId: acme })).toBe(2);
    expect(await tags().count({ orgId: acme })).toBe(0);
    expect(await tags().count({ orgId: other })).toBe(1);
    expect(await tags().deleteWhere({ label: 'urgent' }, { orgId: acme })).toBe(0);
    expect(await tags().count({ orgId: other })).toBe(1);

    expect(await rejectionCode(tags().deleteWhere({}, { orgId: acme }))).toBe('X_WRITE_UNFILTERED');
    expect(await rejectionCode(tags().deleteWhere({ label: 'urgent' }))).toBe('X_TENANCY_UNSCOPED');
  });

  test('a composite-key row is patchable by filter, and only inside its own tenant', async () => {
    const tags = () => postgresRepo(invoiceTags);
    const mine = await write(acme, 'INV-patch');
    const yours = await write(other, 'INV-patch-other');
    const noteOf = async (invoiceId: string, label: string, orgId: string) =>
      (
        await tags().findMany({
          orgId,
          where: [{ column: 'invoiceId', op: 'eq', value: invoiceId }],
        })
      ).rows.find((row) => row.label === label)?.note ?? null;

    for (const label of ['red', 'green', 'blue']) {
      await tags().insert({ invoiceId: mine.id, orgId: acme, label, note: null });
    }
    await tags().insert({ invoiceId: yours.id, orgId: other, label: 'red', note: null });

    // `update(id, patch)` cannot address any of these — the defect, against a real server.
    await expect(tags().update(mine.id, { note: 'x' }, { orgId: acme })).rejects.toThrow(
      /updateWhere/,
    );

    // Nothing matched is 0: not a throw, and not a table-wide write.
    expect(
      await tags().updateWhere(
        { invoiceId: mine.id, label: 'absent' },
        { note: 'x' },
        { orgId: acme },
      ),
    ).toBe(0);

    // Exactly the row the full composite key names.
    expect(
      await tags().updateWhere(
        { invoiceId: mine.id, label: 'red' },
        { note: 'seen' },
        { orgId: acme },
      ),
    ).toBe(1);
    expect(await noteOf(mine.id, 'red', acme)).toBe('seen');
    expect(await noteOf(mine.id, 'green', acme)).toBeNull();

    // A partial filter patches the rest of this invoice's tags…
    expect(
      await tags().updateWhere({ invoiceId: mine.id }, { note: 'bulk' }, { orgId: acme }),
    ).toBe(3);
    expect(await noteOf(mine.id, 'blue', acme)).toBe('bulk');

    // …and the other tenant's identically-labelled row sits behind the org predicate Postgres
    // itself applies, so a filter that matches it on paper reaches only this tenant's copy.
    expect(await tags().updateWhere({ label: 'red' }, { note: 'leak' }, { orgId: acme })).toBe(1);
    expect(await noteOf(yours.id, 'red', other)).toBeNull();

    expect(await rejectionCode(tags().updateWhere({}, { note: 'x' }, { orgId: acme }))).toBe(
      'X_WRITE_UNFILTERED',
    );
    expect(await rejectionCode(tags().updateWhere({ label: 'red' }, {}, { orgId: acme }))).toBe(
      'X_PATCH_EMPTY',
    );
    expect(await rejectionCode(tags().updateWhere({ label: 'red' }, { note: 'x' }))).toBe(
      'X_TENANCY_UNSCOPED',
    );
  });
});
