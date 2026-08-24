import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresDriver, postgresRepo, postgresTransactor } from './pg-driver';
import { clearRegistry } from './registry';

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

/** What Postgres prints for `(col at time zone 'UTC')::text`, from the ISO the fixture names. */
const pgText = (iso: unknown): unknown =>
  typeof iso === 'string' ? iso.replace('T', ' ').replace('Z', '') : iso;

/**
 * What Bun.SQL hands back: snake_case names, int8 as a string, timestamptz as an ISO string —
 * plus `issued_at$US`, the microsecond half of the sort key every read projects beside the column
 * itself (`seekAlias`). Bun hands a `timestamptz` back as a millisecond `Date`, so a recorded row
 * WITHOUT that output is a row this driver's own statement never returns, and a cursor minted from
 * it would be pinned to the wrong precision in exactly the tests meant to prove the precision.
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
    // The sort key comes back TWICE: as the column, and as the microsecond text a cursor is
    // minted from — a `Date` cannot hold the second one.
    expect(lastText()).toStartWith(
      'select "reference", "id", "issued_at", ("issued_at" at time zone \'UTC\')::text ' +
        'as "issued_at$US" from "pg_test_invoices"',
    );
    // `id desc`, not `id asc`: the tiebreak follows the last declared direction, so the order
    // the driver sends is one an index can be declared for.
    expect(lastText()).toContain('order by "issued_at" desc nulls first, "id" desc nulls first');
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

  /**
   * The pin and the transaction cannot both be honoured, and the wrong answer is invisible.
   * `withTransaction` reserved a connection and ran `BEGIN` on it — the ambient pool's — while a
   * repository built with `client:` sends every statement straight to that client, which is a
   * different connection and, on a sharded app, a different database. So the write commits
   * whatever the transaction decides and survives its rollback, and the read cannot see what the
   * transaction has already written. Refused rather than resolved: a `DbTx` does not name the
   * client it was opened on, so "are these the same database" is not a question this layer can ask.
   */
  test('a repo pinned to its own client refuses to run inside a transaction', async () => {
    const shard = createRecordingClient();
    const pinned = postgresRepo(invoices, { client: shard });

    // Outside a transaction it is exactly the repository it always was, on its own client.
    shard.on('select', { rows: [physical()] });
    expect(await pinned.findById(ID, { orgId: ORG })).not.toBeNull();
    expect(shard.statements).toHaveLength(1);

    await expect(
      postgresTransactor().run(async () => {
        await pinned.insert(ROW);
      }),
    ).rejects.toBeUltimateError('X_REPO_CLIENT_PINNED');

    // The write into the wrong connection never happened, on either client.
    expect(shard.statements).toHaveLength(1);
    expect(client.texts.filter((text) => text.startsWith('insert into'))).toHaveLength(0);
    expect(client.texts).toContain('ROLLBACK');
  });

  test('the refusal names the seam that does join a transaction', async () => {
    const shard = createRecordingClient();
    const error = await postgresTransactor()
      .run(async () => postgresRepo(invoices, { client: shard }).count({ orgId: ORG }))
      .then(
        () => undefined,
        (thrown: unknown) => thrown as { readonly fix?: unknown },
      );
    // `db()` resolves `currentTx()` first, which is exactly what a pinned client skips — so the
    // repair is to stop pinning, not to pin harder.
    expect(String(error?.fix)).toContain('setDbClient(client)');
    expect(shard.statements).toHaveLength(0);
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
