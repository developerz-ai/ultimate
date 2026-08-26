// Keyset pagination against a real Postgres — the half of the live suite that walks pages rather
// than writing rows. Split from `pg-driver.live.test.ts` when that file passed the 500-line
// ceiling: one file, one responsibility, and "does a cursor survive a real seek" is a different
// question from "does the driver write what the entity declared".
//
// The fixture is duplicated rather than shared through a helper because each file drops and
// recreates its own tables in `beforeAll`; a shared module would make the two files fight over
// them the moment anything runs them concurrently.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
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
import { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
import { clearRegistry } from './registry';
import type { FindManyArgs, Page } from './repo';

// `TEST_DATABASE_URL` only. `beforeAll`/`afterAll` here run `drop table … cascade`, so falling
// back to the app's own `DATABASE_URL` would hand this file whatever database a developer had
// exported — a skip is the right answer, and CI sets the test url anyway.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_cursor_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const invoices = entity('pg_cursor_invoices', {
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
const invoiceTags = entity('pg_cursor_invoice_tags', {
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
  'drop table if exists "pg_cursor_invoice_tags", "pg_cursor_invoices", "pg_cursor_orgs" cascade';

describe.skipIf(!hasPostgres)('live · postgres · postgresDriver', () => {
  let client: PostgresClient;
  let migration: ReturnType<typeof generateMigration>;
  let acme = '';

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    migration = generateMigration({
      // Declaration order is dependency order: the foreign key needs `pg_cursor_orgs` first.
      entities: [orgs.$describe(), invoices.$describe(), invoiceTags.$describe()],
      name: 'live driver',
      now: new Date('2026-08-10T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));

    const db = database({ orgs }, { driver: postgresDriver() });
    acme = (await db.orgs.insert({ slug: 'acme' })).id;
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
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

  test('a descending listing pages correctly through a real row-comparison seek', async () => {
    const org = await newOrg('cursor-desc');
    const seeded = ['DESC-a', 'DESC-b', 'DESC-c', 'DESC-d', 'DESC-e'];
    for (const reference of seeded) await write(org, reference);

    // `totalOrder` appends the primary key in the last declared key's direction, so the plan is
    // `reference desc, id desc` — one direction throughout, which `seekSql` sends as the row
    // comparison `("reference", "id") < ($1, $2)`. The mixed shape is the test below.
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

  test('a mixed-direction listing pages correctly through the or-chain seek', async () => {
    // `(a, b) < (x, y)` requires every key to sort the same way, so a caller who names the
    // tiebreak in the other direction gets the spelled-out seek instead. Same rows, same order,
    // one row per page so every boundary is a seek — the two shapes have to mean one thing.
    const org = await newOrg('cursor-mixed');
    const seeded = ['MIX-a', 'MIX-b', 'MIX-c', 'MIX-d'];
    for (const reference of seeded) await write(org, reference);

    const mixed: FindManyArgs = {
      orgId: org,
      orderBy: [
        { column: 'reference', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ],
      limit: 1,
    };
    expect(referencesOf(await walkFrom(mixed, null))).toEqual([...seeded].reverse());

    // And the tie the mixed order exists for: two rows sharing a sort value, separated only by
    // the id, with the page boundary falling between them.
    const tied = await newOrg('cursor-mixed-tie');
    const ids = [(await write(tied, 'MIX-TIE')).id, (await write(tied, 'MIX-TIE')).id];
    const walked = await walkFrom({ ...mixed, orgId: tied }, null);
    expect(walked.map((row) => row.id)).toEqual([...ids].sort());
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

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
