// `postgresDriver()` against a real Postgres. `pg-driver.test.ts` asserts the statement text a
// plan compiles to; nothing there proves Postgres accepts it, that the table the framework's own
// migration generator writes is the table the driver reads, or that a value survives the round
// trip. Both bugs this file was written to catch were invisible to a recording client: an entity
// with a `unique()` column generated a migration Postgres refused (`42P07`, the same index twice)
// and money's currency generated as bare `char` — `char(1)` — which no three-letter code fits.
//
// The whole chain runs here: entity() -> describe() -> generateMigration() -> a live server ->
// postgresDriver() -> decoded row. Skips when no admin url is configured, the same as
// `db-integration.test.ts`; CI's `postgres` service container sets `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
} from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
import { clearRegistry } from './registry';
import type { FindManyArgs, Page } from './repo';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];
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

type Invoice = typeof invoices.$row;

const DROP = 'drop table if exists "pg_live_invoices", "pg_live_orgs" cascade';

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
      entities: [orgs.$describe(), invoices.$describe()],
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
  const walkFrom = async (args: FindManyArgs, cursor: string | null): Promise<Invoice[]> => {
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

  const referencesOf = (rows: readonly Invoice[]): string[] => rows.map((row) => row.reference);

  /** The cursor a page had to hand back — otherwise `string | null` leaks into every caller. */
  const cursorOf = (page: Page<Invoice>): string => {
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

  test('a keyset page walks every row exactly once', async () => {
    const org = (
      await database({ orgs }, { driver: postgresDriver() }).orgs.insert({
        slug: 'paging',
      })
    ).id;
    const references = ['a', 'b', 'c', 'd', 'e'].map((letter) => `PAGE-${letter}`);
    for (const reference of references) await write(org, reference);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Page<Invoice> = await repo().findMany({
        orgId: org,
        orderBy: [{ column: 'reference', direction: 'asc' }],
        limit: 2,
        cursor,
      });
      seen.push(...result.rows.map((row) => row.reference));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    // Exactly once, in order, with no page boundary repeating or skipping its neighbour's row.
    expect(seen).toEqual(references);
    expect(await repo().count({ orgId: org })).toBe(5);
  });

  test('a cursor from one plan is refused by another', async () => {
    const org = (
      await database({ orgs }, { driver: postgresDriver() }).orgs.insert({
        slug: 'cursor-scope',
      })
    ).id;
    for (const reference of ['S-1', 'S-2']) await write(org, reference);

    const scoped = { orgId: org };
    const first = await repo().findMany({ ...scoped, limit: 1 });
    expect(first.nextCursor).not.toBeNull();

    // Same rows, different sort — the cursor is bound to the plan, so it cannot be replayed here.
    const elsewhere = repo().findMany({
      ...scoped,
      orderBy: [{ column: 'reference', direction: 'desc' }],
      limit: 1,
      cursor: first.nextCursor,
    });
    await expect(elsewhere).rejects.toThrow();
  });

  test('a row inserted before the cursor position neither duplicates nor skips a row', async () => {
    const org = await newOrg('cursor-insert');
    const seeded = ['SHIFT-b', 'SHIFT-c', 'SHIFT-d', 'SHIFT-e', 'SHIFT-f'];
    for (const reference of seeded) await write(org, reference);

    const listing: FindManyArgs = {
      orgId: org,
      orderBy: [{ column: 'reference', direction: 'asc' }],
      limit: 2,
    };
    const first = await repo().findMany(listing);
    expect(referencesOf(first.rows)).toEqual(['SHIFT-b', 'SHIFT-c']);

    // The write the doc's OFFSET table gets wrong: a row lands *behind* the open cursor, which
    // under OFFSET shifts every later page down one — repeating one row and dropping the next.
    await write(org, 'SHIFT-a');
    const seen = referencesOf([...first.rows, ...(await walkFrom(listing, cursorOf(first)))]);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(seeded);
    // The late row really is in the tenant — it stayed out of the walk because the cursor names a
    // position in the ordering, not a row count taken at some earlier instant.
    expect(await repo().count({ orgId: org })).toBe(6);
  });

  test('the boundary row deleted between pages does not restart pagination', async () => {
    const org = await newOrg('cursor-delete');
    const seeded = ['GAP-a', 'GAP-b', 'GAP-c', 'GAP-d', 'GAP-e'];
    for (const reference of seeded) await write(org, reference);

    const listing: FindManyArgs = {
      orgId: org,
      orderBy: [{ column: 'reference', direction: 'asc' }],
      limit: 2,
    };
    const first = await repo().findMany(listing);
    const boundary = first.rows.at(-1);
    expect(boundary?.reference).toBe('GAP-b');

    // The row the cursor was cut at is gone before the next request — the case an id-only cursor
    // cannot survive, because seeking by a row that is no longer there matches everything again.
    await repo().delete(boundary?.id ?? '', { orgId: org });

    const second = await repo().findMany({ ...listing, cursor: cursorOf(first) });
    expect(referencesOf(second.rows)).toEqual(['GAP-c', 'GAP-d']);
    expect(referencesOf(await walkFrom(listing, cursorOf(second)))).toEqual(['GAP-e']);
  });

  test('a descending listing pages correctly through a real mixed-direction seek', async () => {
    const org = await newOrg('cursor-desc');
    const seeded = ['DESC-a', 'DESC-b', 'DESC-c', 'DESC-d', 'DESC-e'];
    for (const reference of seeded) await write(org, reference);

    // `planFor` always appends the primary key ascending, so the plan is `reference desc, id asc`
    // — a mixed pair no `(a, b) < (x, y)` can express, which is why `seekSql` spells it out.
    const listing: FindManyArgs = {
      orgId: org,
      orderBy: [{ column: 'reference', direction: 'desc' }],
      limit: 2,
    };
    expect(referencesOf(await walkFrom(listing, null))).toEqual([...seeded].reverse());

    // A tie straddling a page boundary, where only the id tiebreak separates the two rows: a seek
    // that compares the sort value alone either loses the second row or returns the first twice.
    const tied = await newOrg('cursor-tie');
    const ids = [(await write(tied, 'TIE')).id, (await write(tied, 'TIE')).id];
    const walked = await walkFrom({ ...listing, orgId: tied, limit: 1 }, null);

    expect(walked.map((row) => row.id).sort()).toEqual([...ids].sort());
  });

  test('a tampered cursor is X_CURSOR_INVALID, not a silent page one', async () => {
    const org = await newOrg('cursor-tamper');
    for (const reference of ['TAMPER-a', 'TAMPER-b', 'TAMPER-c']) await write(org, reference);

    const listing: FindManyArgs = { orgId: org, limit: 1 };
    const live = cursorOf(await repo().findMany(listing));
    const body = live.slice(0, live.lastIndexOf('.'));
    const signature = live.slice(live.lastIndexOf('.') + 1);
    // Derived from the character already there: substituting a fixed one into a hex signature is
    // a no-op one run in sixteen, and a test that only usually fails a forgery proves nothing.
    const forged = `${signature.startsWith('0') ? '1' : '0'}${signature.slice(1)}`;

    expect(await rejectionCode(repo().findMany({ ...listing, cursor: `${body}.${forged}` }))).toBe(
      'X_CURSOR_INVALID',
    );

    // The signature covers the body, so a position lifted from another plan cannot borrow this
    // cursor's signature to get itself accepted — and its scope would not have matched either.
    const elsewhere = cursorOf(
      await repo().findMany({ ...listing, orderBy: [{ column: 'reference', direction: 'desc' }] }),
    );
    const stolen = `${elsewhere.slice(0, elsewhere.lastIndexOf('.'))}.${signature}`;
    expect(await rejectionCode(repo().findMany({ ...listing, cursor: stolen }))).toBe(
      'X_CURSOR_INVALID',
    );
  });

  test('a repository call joins the open transaction without being handed one', async () => {
    const reference = 'INV-rollback';
    const failed = postgresTransactor().run(async () => {
      // No client is threaded through: the repo resolves `db()`, which returns the open tx.
      await write(acme, reference);
      expect(
        await repo().count({
          orgId: acme,
          where: [{ column: 'reference', op: 'eq', value: reference }],
        }),
      ).toBe(1);
      throw new Error('roll it back');
    });
    await expect(failed).rejects.toThrow('roll it back');

    // Outside the transaction the row was never there — a real ROLLBACK, not an undo callback.
    expect(
      await repo().count({
        orgId: acme,
        where: [{ column: 'reference', op: 'eq', value: reference }],
      }),
    ).toBe(0);
  });

  test('a committed transaction leaves its rows behind', async () => {
    const reference = 'INV-commit';
    await postgresTransactor().run(async () => {
      await write(acme, reference);
    });

    expect(
      await repo().count({
        orgId: acme,
        where: [{ column: 'reference', op: 'eq', value: reference }],
      }),
    ).toBe(1);
  });
});
