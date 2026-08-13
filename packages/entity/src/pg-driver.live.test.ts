// `postgresDriver()` against a real Postgres. `pg-driver.test.ts` asserts the statement text a
// plan compiles to; nothing there proves Postgres accepts it, that the table the framework's own
// migration generator writes is the table the driver reads, or that a value survives the round
// trip. Both bugs this file was written to catch were invisible to a recording client: an entity
// with a `unique()` column generated a migration Postgres refused (`42P07`, the same index twice)
// and money's currency generated as bare `char` — `char(1)` — which no three-letter code fits.
//
// The whole chain runs here: entity() -> describe() -> generateMigration() -> a live server ->
// postgresDriver() -> decoded row. Skips unless `TEST_DATABASE_URL` is set, the same as
// `db-integration.test.ts`; CI's `postgres` service container sets it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, isUltimateError, runWithContext } from '@ultimat3/core';
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
import { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
import { clearRegistry } from './registry';
import type { FindManyArgs, Page } from './repo';

// `TEST_DATABASE_URL` only. `beforeAll`/`afterAll` here run `drop table … cascade`, so falling
// back to the app's own `DATABASE_URL` would hand this file whatever database a developer had
// exported — a skip is the right answer, and CI sets the test url anyway.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_live_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const invoices = entity('pg_live_invoices', {
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
 * A composite primary key AND a tenant column — the two things a filtered delete has to survive
 * together. `delete(id)` cannot address a row here at all, which is the defect `deleteWhere` fixes,
 * and asserting the statement text proves nothing about whether Postgres accepts `delete … where
 * "invoice_id" = $1 and "label" = $2 and "org_id" = $3` or removes only the rows it names.
 */
const invoiceTags = entity('pg_live_invoice_tags', {
  columns: {
    invoiceId: uuid().references(() => invoices.id, { onDelete: 'cascade' }),
    label: text({ max: 40 }),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    /** A non-key column, so `updateWhere` has something to write that is not part of the key. */
    note: text().nullable(),
  },
  primaryKey: ['invoiceId', 'label'],
});

type Invoice = typeof invoices.$row;

const DROP =
  'drop table if exists "pg_live_invoice_tags", "pg_live_invoices", "pg_live_orgs" cascade';

/**
 * The generator returns one `up` script; a driver executes one statement. Splitting on `;\n` is
 * enough because every value in a generated clause is an identifier or a CHECK the entity wrote,
 * and none of those can contain a semicolon.
 */
const statementsOf = (script: string): readonly string[] =>
  script
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

describe.skipIf(!hasPostgres)('live · postgres · postgresDriver', () => {
  let client: PostgresClient;
  let migration: ReturnType<typeof generateMigration>;
  let acme = '';
  let other = '';

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    migration = generateMigration({
      // Declaration order is dependency order: the foreign key needs `pg_live_orgs` first.
      entities: [orgs.$describe(), invoices.$describe(), invoiceTags.$describe()],
      name: 'live driver',
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
      total: { minor: 1000n, currency: 'USD' },
      ...patch,
    });

  /** A page walk asserts over a whole tenant, so each one needs a tenant nobody else wrote to. */
  const newOrg = async (slug: string): Promise<string> =>
    (await database({ orgs }, { driver: postgresDriver() }).orgs.insert({ slug })).id;

  /** Pages to exhaustion from `cursor`, in the order the driver handed the rows back. */
  const _walkFrom = async (args: FindManyArgs, cursor: string | null): Promise<Invoice[]> => {
    const rows: Invoice[] = [];
    let next = cursor;
    let more = true;
    // Bounded: a seek that stops advancing has to fail the test, never hang the run.
    for (let page = 0; page < 12 && more; page += 1) {
      const result: Page<Invoice> = await repo().findMany({ ...args, cursor: next });
      rows.push(...result.rows);
      next = result.nextCursor;
      more = next !== null;
    }
    expect(next).toBeNull();
    return rows;
  };

  const _referencesOf = (rows: readonly Invoice[]): string[] => rows.map((row) => row.reference);

  /** The cursor a page had to hand back — otherwise `string | null` leaks into every caller. */
  const _cursorOf = (page: Page<Invoice>): string => {
    expect(page.nextCursor).toBeTypeOf('string');
    return page.nextCursor ?? '';
  };

  /** The stable code a call rejected with. Message text is not the contract; the code is. */
  const rejectionCode = async (call: Promise<unknown>): Promise<string> => {
    try {
      await call;
      return 'resolved';
    } catch (error) {
      return isUltimateError(error) ? error.code : String(error);
    }
  };

  test('the generated migration is a migration Postgres accepts', () => {
    // Both halves are load-bearing and both were wrong: the unique column must not also get an
    // explicit `create unique index` (Postgres already made one under that exact name), and the
    // currency must carry its length or the CHECK on the same line can never be satisfied.
    expect(migration.up).toContain('"slug" text not null unique');
    expect(migration.up).not.toContain('create unique index "pg_live_orgs_slug_key"');
    expect(migration.up).toContain('"total_currency" char(3)');
    // beforeAll applied it; a table that did not exist would have failed every statement after.
    expect(statementsOf(migration.up).length).toBeGreaterThan(0);
  });

  test('a row survives the round trip through real column types', async () => {
    const written = await write(acme, 'INV-round-trip', {
      total: { minor: 12_500n, currency: 'EUR' },
    });

    // Every one of these came back from Postgres, not from the object that was passed in.
    expect(written.total).toEqual({ minor: 12_500n, currency: 'EUR' });
    expect(written.paid).toBe(false);
    expect(written.note).toBeNull();
    expect(written.issuedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(written.issuedAt.getTime())).toBe(false);
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/);

    const read = await repo().findById(written.id, { orgId: acme });
    expect(read?.total).toEqual({ minor: 12_500n, currency: 'EUR' });
    expect(read?.reference).toBe('INV-round-trip');
  });

  test('a CHECK the entity declared is enforced by Postgres, not only by $assert', async () => {
    // `total_currency ~ '^[A-Z]{3}$'` is a real constraint on a real table. Reaching it means
    // going around `$assert`, which is exactly what a second writer to the same database does.
    const insert = client.execute(
      raw(
        `insert into "pg_live_invoices" ("org_id", "reference", "total_minor", "total_currency")` +
          ` values ('${acme}', 'INV-bad', 100, 'us')`,
      ),
    );
    await expect(insert).rejects.toThrow();
  });

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

  test('update writes the patch and returns the row Postgres stored', async () => {
    const written = await write(acme, 'INV-update');
    const updated = await repo().update(
      written.id,
      { paid: true, note: 'settled', total: { minor: 999n, currency: 'GBP' } },
      { orgId: acme },
    );

    expect(updated.paid).toBe(true);
    expect(updated.note).toBe('settled');
    expect(updated.total).toEqual({ minor: 999n, currency: 'GBP' });
    expect((await repo().findById(written.id, { orgId: acme }))?.note).toBe('settled');
  });

  test('soft delete hides the row and includeDeleted brings it back', async () => {
    const written = await write(acme, 'INV-soft');
    await repo().delete(written.id, { orgId: acme });

    expect(await repo().findById(written.id, { orgId: acme })).toBeNull();
    const revealed = await repo().findById(written.id, { orgId: acme, includeDeleted: true });
    expect(revealed?.deletedAt).toBeInstanceOf(Date);
  });

  test('point lookups in one request are one statement, and it answers like the singles did', async () => {
    const first = await write(acme, 'INV-batch-1');
    const second = await write(acme, 'INV-batch-2');
    const hidden = await write(acme, 'INV-batch-3');
    await repo().delete(hidden.id, { orgId: acme });
    const foreign = await write(other, 'INV-batch-4');

    // The observer is how "one statement" is asserted against a real server: there is no
    // recording client here, and the count is the whole claim.
    const reads: string[] = [];
    setStatementObserver({
      onStatement: (event) => {
        if (event.text.includes('from "pg_live_invoices"')) reads.push(event.text);
      },
    });
    try {
      const rows = await runWithContext(createContext(), () =>
        Promise.all([
          repo().findById(first.id, { orgId: acme }),
          repo().findById(second.id, { orgId: acme }),
          repo().findById(hidden.id, { orgId: acme }),
          repo().findById(foreign.id, { orgId: acme }),
          repo().findById(first.id, { orgId: acme }),
        ]),
      );

      expect(reads).toHaveLength(1);
      // Five lookups, four binds: the repeated id is one of them.
      expect(reads[0]).toContain('"id" in ($1, $2, $3, $4)');
      // Every answer is the one the single statement gave — Postgres applied the tenant predicate
      // and the `deleted_at is null` clause inside the coalesced statement, not the process after.
      expect(rows.map((row) => row?.reference ?? null)).toEqual([
        'INV-batch-1',
        'INV-batch-2',
        null,
        null,
        'INV-batch-1',
      ]);
    } finally {
      setStatementObserver(undefined);
    }
  });

  test('a sequential loop over a page of tags is two statements against the invoices it points at', async () => {
    // The JIT-preload half of the same claim, against a real server: `findMany` on `invoiceTags`
    // leaves its page's `invoiceId` values behind, so a `for … of` loop that follows — one
    // `await` per iteration, no two lookups sharing a microtask — costs one widened `in` query
    // for the whole page, not one `select` per row.
    const org = await newOrg('jit-live');
    const tags = () => postgresRepo(invoiceTags);
    const written = await Promise.all(
      ['JIT-1', 'JIT-2', 'JIT-3'].map((reference) => write(org, reference)),
    );
    for (const invoice of written) {
      await tags().insert({ invoiceId: invoice.id, orgId: org, label: 'primary', note: null });
    }

    const statements: string[] = [];
    setStatementObserver({ onStatement: (event) => statements.push(event.text) });
    try {
      const references = await runWithContext(createContext(), async () => {
        const page = await tags().findMany({ orgId: org });
        const seen: string[] = [];
        for (const tagRow of page.rows) {
          const invoice = await repo().findById(tagRow.invoiceId, { orgId: org });
          seen.push(invoice?.reference ?? 'missing');
        }
        return seen;
      });

      // The tags page, and one `in (…)` statement for the three invoices it named — never three.
      expect(statements).toHaveLength(2);
      expect(statements[1]).toContain('from "pg_live_invoices"');
      expect(statements[1]).toContain('"id" in ($1, $2, $3)');
      expect(references.slice().sort()).toEqual(['JIT-1', 'JIT-2', 'JIT-3']);
    } finally {
      setStatementObserver(undefined);
    }
  });

  test('delete on an entity without a soft-delete column removes the row', async () => {
    const target = await database({ orgs }, { driver: postgresDriver() }).orgs.insert({
      slug: 'hard-delete',
    });
    await postgresRepo(orgs).delete(target.id);

    expect(await postgresRepo(orgs).findById(target.id)).toBeNull();
    const rows = await client.query<{ count: string }>(
      raw(`select count(*) as count from "pg_live_orgs" where "slug" = 'hard-delete'`),
    );
    expect(Number(rows[0]?.count)).toBe(0);
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

  test('updateWhere cannot reach a soft-deleted row, and rolls back with its transaction', async () => {
    const org = await newOrg('update-where');
    const target = await write(org, 'PATCH-a');
    await write(org, 'PATCH-b');

    expect(await repo().updateWhere({ paid: false }, { note: 'both' }, { orgId: org })).toBe(2);
    expect((await repo().findById(target.id, { orgId: org }))?.note).toBe('both');

    // Soft-delete one, then patch the pair again: only the live row is reachable, exactly as
    // `update(id, patch)` on the deleted one would have been X_NOT_FOUND.
    await repo().delete(target.id, { orgId: org });
    expect(await repo().updateWhere({ paid: false }, { note: 'live only' }, { orgId: org })).toBe(
      1,
    );
    expect((await repo().findById(target.id, { orgId: org, includeDeleted: true }))?.note).toBe(
      'both',
    );

    const failed = postgresTransactor().run(async () => {
      expect(await repo().updateWhere({ paid: false }, { note: 'rolled' }, { orgId: org })).toBe(1);
      throw new Error('roll it back');
    });
    await expect(failed).rejects.toThrow('roll it back');
    expect(
      (await repo().findMany({ orgId: org })).rows.every((row) => row.note === 'live only'),
    ).toBe(true);
  });

  test('deleteWhere soft-deletes where delete(id) would, and rolls back with its transaction', async () => {
    const org = await newOrg('delete-where-soft');
    for (const reference of ['SOFT-a', 'SOFT-b']) await write(org, reference);

    expect(await repo().deleteWhere({ paid: false }, { orgId: org })).toBe(2);
    expect(await repo().count({ orgId: org })).toBe(0);
    expect(await repo().count({ orgId: org, includeDeleted: true })).toBe(2);
    // Already stamped, so the `deleted_at is null` clause means a second call matches nothing —
    // the row's original deletion time survives.
    expect(await repo().deleteWhere({ paid: false }, { orgId: org })).toBe(0);

    const survivor = await newOrg('delete-where-rollback');
    await write(survivor, 'ROLL-a');
    const failed = postgresTransactor().run(async () => {
      expect(await repo().deleteWhere({ reference: 'ROLL-a' }, { orgId: survivor })).toBe(1);
      throw new Error('roll it back');
    });
    await expect(failed).rejects.toThrow('roll it back');
    expect(await repo().count({ orgId: survivor })).toBe(1);
  });
});
