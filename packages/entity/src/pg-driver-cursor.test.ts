// Keyset pagination in the Postgres driver, against a recording client: what the seek predicate
// LOOKS like, and what a page position is minted from. Split from `pg-driver.test.ts` when that
// file passed the 500-line ceiling — "what statement does a cursor compile to" is a different
// question from "does every method send the statement the entity declared".
//
// The fixture is its own, with its own entity names: two test files registering one entity name
// collide in the single process `bun test packages/entity/src` runs them in.
// `pg-driver-cursor.live.test.ts` walks the same pages against a real server.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const orgs = entity('pg_keyset_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const invoices = entity('pg_keyset_invoices', {
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
const ID = '00000000-0000-7000-8000-000000000101';

/** What Postgres prints for `(col at time zone 'UTC')::text`, from the ISO the fixture names. */
const pgText = (iso: unknown): unknown =>
  typeof iso === 'string' ? iso.replace('T', ' ').replace('Z', '') : iso;

/**
 * What Bun.SQL hands back, plus `issued_at$US` — the microsecond half of the sort key every read
 * projects beside the column itself (`seekAlias`). Bun hands a `timestamptz` back as a millisecond
 * `Date`, so a recorded row WITHOUT that output is a row this driver's statement never returns,
 * and every cursor minted from it would be pinned to the wrong precision in exactly the tests
 * meant to prove the precision.
 */
const physical = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const row: Record<string, unknown> = {
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
  };
  return { ...row, issued_at$US: pgText(row['issued_at']) };
};

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
    // Every key sorts the same way, so the seek is one ROW COMPARISON — the shape Postgres pushes
    // into a multicolumn index as a single Index Cond. Both sides of it are plain comparisons
    // against bare columns, on exactly the equality class `order by` sorts on, which is what
    // carrying the cursor at the column's own precision bought.
    expect(lastText()).toContain('(("issued_at", "id") < ($2::timestamptz, $3))');
    expect(lastValues()[1]).toBe('2026-01-03T00:00:00.000000Z');
  });

  test('a MIXED order falls back to the or-chain, which is the only shape that expresses it', async () => {
    // `(a, b) > (x, y)` requires every key to sort the same way. A caller who writes the mixed
    // order themselves still gets a correct seek — spelled out, one term per key, with the
    // equality prefix each later key's tiebreak hangs off.
    const mixed = {
      orgId: ORG,
      limit: 3,
      orderBy: [
        { column: 'issuedAt', direction: 'desc' as const },
        { column: 'id', direction: 'asc' as const },
      ],
    };
    client.on('select', { rows: page(4) });
    const first = await repo().findMany(mixed);
    await repo().findMany({ ...mixed, cursor: first.nextCursor });
    expect(lastText()).toContain(
      '(("issued_at" < $2::timestamptz) or ("issued_at" = $3::timestamptz and "id" > $4))',
    );
  });

  /**
   * The column is `timestamptz` (microseconds, `now()`) and a decoded row is a `Date`
   * (milliseconds). A cursor minted from the decoded value is the row's position FLOORED, which
   * is a position no row occupies: `<` dropped every row inside that millisecond and `>` served
   * the boundary row again. The seek binds the column's own microsecond instead, so the position
   * is a row's rather than a millisecond's — `pg-cursor-precision.live.test.ts` walks the pages
   * on a real server.
   */
  test('a timestamp seek is exact to the microsecond the column stores', async () => {
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

    // The bind is the row's OWN microsecond. `.123` — the value a `Date` can hold — is a position
    // between two rows, and the rows on the wrong side of it were served on no page at all.
    expect(lastText()).toContain('(("issued_at", "id") > ($2::timestamptz, $3))');
    expect(lastValues()[1]).toBe('2026-08-14T10:00:00.123456Z');

    client.on('select', { rows });
    const firstDesc = await repo().findMany(descending);
    await repo().findMany({ ...descending, cursor: firstDesc.nextCursor });
    // Descending binds the same value at the same precision — one bind now, because the whole
    // seek is one row comparison rather than a term per key.
    expect(lastText()).toContain('(("issued_at", "id") < ($2::timestamptz, $3))');
    expect(lastValues()[1]).toBe('2026-08-14T10:00:00.123456Z');
  });

  test('a nullable sort column pages, with NULL where the ordering says it goes', async () => {
    const byDeletedAt = {
      orgId: ORG,
      limit: 3,
      includeDeleted: true,
      orderBy: [{ column: 'deletedAt', direction: 'asc' as const }],
    };
    // The boundary row HOLDS a value: the null-position cases are the two tests below.
    const stamped = page(4).map((row, index) => ({
      ...row,
      deleted_at: `2026-02-0${index + 1}T00:00:00.000Z`,
    }));
    client.on('select', { rows: stamped });
    const first = await repo().findMany(byDeletedAt);
    expect(lastText()).toContain('order by "deleted_at" asc nulls last, "id" asc nulls last');
    // A nullable key cannot use the row comparison: `(a, b) < ($1, $2)` is UNKNOWN when either
    // side holds a NULL, so every NULL row would be excluded from the page the ordering puts it
    // on. The or-chain reaches them — `or "deleted_at" is null` — and only on a nullable column.
    await repo().findMany({ ...byDeletedAt, cursor: first.nextCursor });
    expect(lastText()).toContain('("deleted_at" > $2::timestamptz or "deleted_at" is null)');
    expect(lastText()).not.toContain('("deleted_at", "id")');
    expect(lastText()).toContain('("deleted_at" = $3::timestamptz and "id" > $4)');
  });

  test('an ascending seek from a NULL position drops its own term, never emits dead SQL', async () => {
    // Under `nulls last` nothing sorts after a NULL, so that key's term can never be true. Emitting
    // it anyway is SQL the planner has to defeat on every page past the first NULL.
    const nulls = page(4).map((row) => ({ ...row, deleted_at: null }));
    client.on('select', { rows: nulls });
    const byDeletedAt = {
      orgId: ORG,
      limit: 3,
      includeDeleted: true,
      orderBy: [{ column: 'deletedAt', direction: 'asc' as const }],
    };
    const first = await repo().findMany(byDeletedAt);
    await repo().findMany({ ...byDeletedAt, cursor: first.nextCursor });
    expect(lastText()).toContain('("deleted_at" is null and "id" > $2)');
    expect(lastText()).not.toContain('"deleted_at" >');
  });

  test('a descending seek from a NULL position reaches every non-null row', async () => {
    // `desc nulls first` puts the NULLs at the top, so the rest of the listing is every row that
    // has a value — `is not null`, not a bound comparison no NULL can satisfy.
    const nulls = page(4).map((row) => ({ ...row, deleted_at: null }));
    client.on('select', { rows: nulls });
    const byDeletedAt = {
      orgId: ORG,
      limit: 3,
      includeDeleted: true,
      orderBy: [{ column: 'deletedAt', direction: 'desc' as const }],
    };
    const first = await repo().findMany(byDeletedAt);
    await repo().findMany({ ...byDeletedAt, cursor: first.nextCursor });
    expect(lastText()).toContain('"deleted_at" is not null');
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
