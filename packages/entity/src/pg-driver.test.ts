import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

const orgs = entity('pg_test_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const invoices = entity('pg_test_invoices', {
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

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-7000-8000-0000000000a2';
const ID = '00000000-0000-7000-8000-000000000101';
const OTHER_ID = '00000000-0000-7000-8000-000000000102';

/** What Bun.SQL hands back: snake_case names, int8 as a string, timestamptz as an ISO string. */
const physical = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  org_id: ORG,
  reference: 'INV-1',
  total_minor: '129900',
  total_currency: 'EUR',
  paid: false,
  note: null,
  issued_at: '2026-01-02T03:04:05.000Z',
  deleted_at: null,
  ...over,
});

const ROW: Invoice = {
  id: ID,
  orgId: ORG,
  reference: 'INV-1',
  total: { minor: 129900, currency: 'EUR' },
  paid: false,
  note: null,
  issuedAt: new Date('2026-01-02T03:04:05.000Z'),
  deletedAt: null,
};

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const repo = () => postgresRepo(invoices);
const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];

describe('postgresRepo() reads', () => {
  test('every value is bound, never spliced into the text', async () => {
    await repo().findMany({
      orgId: ORG,
      where: [{ column: 'reference', op: 'eq', value: "x'; drop table pg_test_invoices; --" }],
    });
    expect(lastText()).not.toContain('drop table');
    expect(lastText()).toContain('"reference" = $1');
    expect(lastValues().slice(0, 2)).toEqual(["x'; drop table pg_test_invoices; --", ORG]);
  });

  test('a read hides soft-deleted rows, totally orders, and fetches one row past the page', async () => {
    await repo().findMany({ orgId: ORG, limit: 5 });
    expect(lastText()).toContain('"deleted_at" is null');
    expect(lastText()).toContain('order by "id" asc');
    expect(lastText()).toEndWith('limit $2');
    expect(lastValues().at(-1)).toBe(6);
  });

  test('includeDeleted drops the soft-delete filter', async () => {
    await repo().findMany({ orgId: ORG, includeDeleted: true });
    expect(lastText()).not.toContain('"deleted_at" is null');
  });

  test('a projection still carries the primary key and the sort keys', async () => {
    await repo().findMany({
      orgId: ORG,
      select: ['reference'],
      orderBy: [{ column: 'issuedAt', direction: 'desc' }],
    });
    expect(lastText()).toStartWith('select "reference", "id", "issued_at" from "pg_test_invoices"');
    expect(lastText()).toContain('order by "issued_at" desc, "id" asc');
  });

  test('a row from the driver is re-parsed by the column that declared it', async () => {
    client.on('select', { rows: [physical()] });
    const [row] = (await repo().findMany({ orgId: ORG })).rows;
    expect(row?.total).toEqual({ minor: 129900, currency: 'EUR' });
    expect(row?.issuedAt).toBeInstanceOf(Date);
    expect(row?.issuedAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(row?.note).toBeNull();
  });

  test('an empty in-list matches nothing instead of emitting invalid SQL', async () => {
    await repo().count({ orgId: ORG, where: [{ column: 'reference', op: 'in', value: [] }] });
    expect(lastText()).toStartWith('select count(*) as count from "pg_test_invoices" where 1 = 0');
  });

  test('like keeps its SQL meaning and stays a bound parameter', async () => {
    await repo().findMany({
      orgId: ORG,
      where: [{ column: 'reference', op: 'like', value: 'INV-%' }],
    });
    expect(lastText()).toContain('"reference" like $1');
    expect(lastValues()[0]).toBe('INV-%');
  });

  test('an undeclared column is a declaration error, not a query', async () => {
    await expect(
      repo().findMany({ orgId: ORG, where: [{ column: 'secret', op: 'eq', value: 1 }] }),
    ).rejects.toThrow(/no column "secret"/);
    expect(client.statements).toHaveLength(0);
  });

  test('money must be addressed by part, because two columns back it', async () => {
    await expect(
      repo().findMany({ orgId: ORG, where: [{ column: 'total', op: 'gt', value: 1 }] }),
    ).rejects.toThrow(/total is money: name total\.minor or total\.currency/);
    await repo().findMany({
      orgId: ORG,
      where: [{ column: 'total.minor', op: 'gt', value: 100n }],
    });
    expect(lastText()).toContain('"total_minor" > $1');
  });
});

describe('postgresRepo() writes', () => {
  test('insert splits money into two columns and returns what Postgres stored', async () => {
    client.on('insert into', { rows: [physical()] });
    const row = await repo().insert(ROW);
    expect(lastText()).toContain('"total_minor", "total_currency"');
    expect(lastText()).toEndWith('returning *');
    expect(lastValues()).toContain(129900);
    expect(lastValues()).toContain('EUR');
    expect(row.total).toEqual({ minor: 129900, currency: 'EUR' });
  });

  test('a writer may still hand a bigint, and both drivers store the value type', async () => {
    // The write half stays wide on purpose: a minor unit read straight off a `bigint` column —
    // hand-written SQL, a backfill — reaches an insert with no conversion at the call site. What
    // it must NOT do is reach the statement or the row still a bigint, because the value type is
    // `@ultimat3/schema`'s `MoneyValue` and every surface downstream of here serialises it.
    const wide = { ...ROW, total: { minor: 129900n, currency: 'EUR' } };
    client.on('insert into', { rows: [physical()] });
    const written = await repo().insert(wide);
    expect(lastValues()).toContain(129900);
    expect(lastValues().every((value) => typeof value !== 'bigint')).toBe(true);

    // Parity: `narrowMoney` is the one rule, so the in-memory row is the same row. Without it the
    // memory driver would store the caller's bigint and `JSON.stringify` would refuse that row.
    const stored = await memoryRepo(invoices).insert(wide);
    expect(stored.total).toEqual({ minor: 129900, currency: 'EUR' });
    expect(stored.total).toEqual(written.total);
    expect(JSON.parse(JSON.stringify(stored)).total).toEqual({ minor: 129900, currency: 'EUR' });
  });

  test('a stored minor unit past ±2^53 is refused, never rounded into the row', async () => {
    // The column holds it; no JS number does. Answering with a rounded amount would be a wrong
    // number nobody can see, so the read refuses and names the value it could not carry.
    client.on('select', { rows: [physical({ total_minor: '9007199254740993' })] });
    await expect(repo().findMany({ orgId: ORG })).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('update sets only the patched columns and scopes by tenant', async () => {
    client.on('update', { rows: [physical({ reference: 'INV-2' })] });
    const row = await repo().update(ID, { reference: 'INV-2' }, { orgId: ORG });
    expect(lastText()).toStartWith(
      'update "pg_test_invoices" set "reference" = $1 where "id" = $2 and "org_id" = $3',
    );
    expect(lastText()).toEndWith('returning *');
    expect(row.reference).toBe('INV-2');
  });

  test('update raises X_NOT_FOUND when the scoped row is not there', async () => {
    await expect(repo().update(ID, { reference: 'x' }, { orgId: ORG })).rejects.toBeUltimateError(
      'X_NOT_FOUND',
    );
  });

  test('delete soft-deletes when the entity carries the column', async () => {
    client.on('update', { affected: 1 });
    await repo().delete(ID, { orgId: ORG });
    expect(lastText()).toStartWith('update "pg_test_invoices" set "deleted_at" = $1');
    expect(lastValues()[0]).toBeInstanceOf(Date);
  });

  test('delete raises X_NOT_FOUND when nothing was affected', async () => {
    await expect(repo().delete(ID, { orgId: ORG })).rejects.toBeUltimateError('X_NOT_FOUND');
  });

  test('a hard delete is a delete when there is no soft-delete column', async () => {
    client.on('delete from', { affected: 1 });
    await postgresRepo(orgs).delete(ORG);
    expect(lastText()).toBe('delete from "pg_test_orgs" where "id" = $1');
  });
});

describe('tenancy', () => {
  test('every operation refuses to run without an org predicate', async () => {
    await expect(repo().findMany()).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(repo().findById(ID)).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(repo().count()).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(repo().update(ID, {})).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(repo().delete(ID)).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(client.statements).toHaveLength(0);
  });
});

describe('keyset pagination', () => {
  const page = (count: number): readonly Record<string, unknown>[] =>
    Array.from({ length: count }, (_, index) =>
      physical({
        id: `00000000-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`,
        issued_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      }),
    );

  const descending = {
    orgId: ORG,
    limit: 3,
    orderBy: [{ column: 'issuedAt', direction: 'desc' as const }],
  };

  test('a cursor appears only when a row past the page came back', async () => {
    client.on('select', { rows: page(3) });
    expect((await repo().findMany({ orgId: ORG, limit: 3 })).nextCursor).toBeNull();
    client.on('select', { rows: page(4) });
    expect((await repo().findMany({ orgId: ORG, limit: 3 })).nextCursor).not.toBeNull();
  });

  test('the cursor becomes a seek predicate, never an offset', async () => {
    client.on('select', { rows: page(4) });
    const first = await repo().findMany(descending);
    await repo().findMany({ ...descending, cursor: first.nextCursor });
    expect(lastText()).not.toContain('offset');
    // `desc` on the first key and `asc` on the tie-breaking primary key: one row comparison
    // cannot express that, which is why the seek is spelled out as an or-chain. The equality
    // prefix is the millisecond window the cursor value stands for — see the microsecond case.
    expect(lastText()).toContain(
      '(("issued_at" < $2) or (("issued_at" >= $3 and "issued_at" < $4) and "id" > $5))',
    );
    expect(lastValues()[1]).toBeInstanceOf(Date);
  });

  /**
   * The column is `timestamptz` (microseconds, `now()`); the cursor carries a `Date`
   * (milliseconds). The floored value is strictly LESS than the row it was minted from, so a bare
   * `>` returned that row again on every page boundary and a bare `<` dropped every row sharing
   * its millisecond. Both directions are the same off-by-one gap.
   */
  test('a timestamp seek excludes the row it was minted from, to the microsecond', async () => {
    // Row 3 is the page boundary — the row the cursor is minted from — and Postgres stored it
    // with the microseconds `now()` gives every `timestamptz`.
    const rows = [
      ...page(2),
      physical({
        id: '00000000-0000-7000-8000-000000000298',
        issued_at: '2026-08-14T10:00:00.123456Z',
      }),
      physical({ id: '00000000-0000-7000-8000-000000000299', issued_at: '2026-08-15T00:00:00Z' }),
    ];
    const ascending = {
      orgId: ORG,
      limit: 3,
      orderBy: [{ column: 'issuedAt', direction: 'asc' as const }],
    };

    client.on('select', { rows });
    const first = await repo().findMany(ascending);
    await repo().findMany({ ...ascending, cursor: first.nextCursor });

    // `>=` the next millisecond, never `>` the floored value: `.123456 > .123` is true, and the
    // row on the page boundary would have been served again as the first row of the next page.
    expect(lastText()).toContain('(("issued_at" >= $2) or');
    const seekAt = lastValues()[1];
    expect(seekAt).toBeInstanceOf(Date);
    expect((seekAt as Date).toISOString()).toBe('2026-08-14T10:00:00.124Z');

    client.on('select', { rows });
    const firstDesc = await repo().findMany(descending);
    await repo().findMany({ ...descending, cursor: firstDesc.nextCursor });
    // Descending needs no shift — `< v` already means "before the whole millisecond" — but the
    // tiebreak does, or every row inside that millisecond is skipped rather than compared by id.
    expect(lastValues()[1]).toEqual(new Date('2026-08-14T10:00:00.123Z'));
    expect(lastValues()[2]).toEqual(new Date('2026-08-14T10:00:00.123Z'));
    expect(lastValues()[3]).toEqual(new Date('2026-08-14T10:00:00.124Z'));
  });

  test('a nullable sort column cannot carry a cursor', async () => {
    const byDeletedAt = {
      orgId: ORG,
      limit: 3,
      includeDeleted: true,
      orderBy: [{ column: 'deletedAt', direction: 'asc' as const }],
    };
    // Refused where the cursor would be minted — on the page that has a next page — rather than
    // on the request that tries to use it. The ordering is the author's mistake either way, and
    // deferring it makes the page size decide whether anyone ever sees it.
    client.on('select', { rows: page(4) });
    await expect(repo().findMany(byDeletedAt)).rejects.toThrow(
      /deletedAt is nullable and cannot carry a cursor/,
    );
  });
});

describe('parity with the in-memory driver', () => {
  test('both drivers expose the same repository surface, bar the memory test seam', () => {
    const postgres = Object.keys(postgresRepo(invoices)).sort();
    const memory = Object.keys(memoryRepo(invoices)).sort();
    // `reset()` is the one permitted difference: rows in Postgres belong to the app, and a
    // framework that could empty them from a test helper eventually would.
    expect(memory.filter((key) => key !== 'reset')).toEqual(postgres);
    expect(memory).toContain('reset');
  });

  test('a cursor from memory is a seek predicate in Postgres', async () => {
    const memory = memoryRepo(invoices, [
      ROW,
      { ...ROW, id: `${ID.slice(0, -1)}2`, issuedAt: new Date('2026-02-02T00:00:00.000Z') },
    ]);
    const first = await memory.findMany({ orgId: ORG, limit: 1 });
    expect(first.nextCursor).not.toBeNull();

    await postgresRepo(invoices).findMany({ orgId: ORG, limit: 1, cursor: first.nextCursor });
    expect(lastText()).toContain('("id" > $2)');
    expect(lastValues()[1]).toBe(ID);
  });
});

describe('composition', () => {
  test('postgresDriver() gives database() a Postgres-backed table per entity', async () => {
    client.on('select', { rows: [physical()] });
    const db = database({ orgs, invoices }, { driver: postgresDriver({ client }) });
    const row = await db.invoices.where({ orgId: ORG }).one();
    expect(row?.reference).toBe('INV-1');
    expect(lastText()).toContain('from "pg_test_invoices"');
  });

  test('a repo inside postgresTransactor() joins the transaction without being handed one', async () => {
    client.on('insert into', { rows: [physical()] });
    await postgresTransactor().run(async () => {
      await repo().insert(ROW);
    });
    expect(client.texts[0]).toBe('BEGIN');
    expect(client.texts[1]).toStartWith('insert into "pg_test_invoices"');
    expect(client.texts.at(-1)).toBe('COMMIT');
  });

  test('a failing unit of work rolls back and never commits', async () => {
    await expect(
      postgresTransactor().run(async () => {
        await repo().count({ orgId: ORG });
        throw new RangeError('boom');
      }),
    ).rejects.toThrow('boom');
    expect(client.texts).toContain('ROLLBACK');
    expect(client.texts).not.toContain('COMMIT');
  });
});

describe('postgresRepo() jitPreload config', () => {
  /**
   * A page of invoices carries `orgId`, a foreign key to `orgs`, so an enabled page leaves both
   * org ids behind and the sequential loop that follows costs one widened statement for the two of
   * them. Disabled, it is the two statements a loop always sent — which is the only difference the
   * switch makes, and the reason this counts statements rather than asserting the page came back.
   */
  const pageThenLoop = async (jitPreload: boolean): Promise<number> => {
    client.on('from "pg_test_invoices"', {
      rows: [physical({ id: ID }), physical({ id: OTHER_ID, org_id: OTHER_ORG })],
    });
    client.on('from "pg_test_orgs"', {
      rows: [
        { id: ORG, slug: 'ours' },
        { id: OTHER_ORG, slug: 'theirs' },
      ],
    });
    await runWithContext(createContext({ actor: userActor({ id: ID, orgId: ORG }) }), async () => {
      const page = await postgresRepo(invoices, { jitPreload }).findMany({ orgId: ORG, limit: 2 });
      // A `for … of` awaits between iterations, so no two of these share a microtask: only the
      // page they came from can batch them.
      for (const invoice of page.rows) await postgresRepo(orgs).findById(invoice.orgId);
    });
    return client.statements.length;
  };

  test('defaults to enabled, so the page batches the loop that follows it', async () => {
    expect(await pageThenLoop(true)).toBe(2);
    expect(lastText()).toContain('"id" in ($1, $2)');
  });

  test('disabled, the loop after the page is the statements it always sent', async () => {
    expect(await pageThenLoop(false)).toBe(3);
  });
});
