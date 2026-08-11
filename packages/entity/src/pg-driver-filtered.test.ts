// The two FILTERED writes — `deleteWhere` and `updateWhere` — in both drivers. Split from
// `pg-driver.test.ts` when that file passed the 500-line ceiling. They belong together and apart
// from the rest: an id-addressed write answers "did it write the row I named", a filtered one
// answers "did it write ONLY the rows I bounded", and the second question is where the blast
// radius lives.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { boolean, money, text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
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

/**
 * The shape `delete(id)` cannot address: two key columns, no soft-delete column. `likes`,
 * `blocks`, `friendships` and `participants` in the reference app are all this — until
 * `deleteWhere` there was no way to remove one of these rows at all.
 */
const likes = entity('pg_test_likes', {
  columns: {
    postId: uuid(),
    userId: uuid(),
    createdAt: timestamp().defaultNow(),
    // Here so `updateWhere` can be held to the same `onUpdateNow()` stamping `update(id, patch)`
    // does — on the shape that has no id to update by, which is the whole point.
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  primaryKey: ['postId', 'userId'],
});

type Invoice = typeof invoices.$row;
type Like = typeof likes.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-7000-8000-0000000000a2';
const ID = '00000000-0000-7000-8000-000000000101';

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
  total: { minor: 129900n, currency: 'EUR' },
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

const _repo = () => postgresRepo(invoices);
const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];

describe('deleteWhere(), in both drivers', () => {
  const POST_A = '00000000-0000-7000-8000-0000000003a1';
  const POST_B = '00000000-0000-7000-8000-0000000003b1';
  const USER_A = '00000000-0000-7000-8000-0000000004a1';
  const USER_B = '00000000-0000-7000-8000-0000000004b1';
  const STRANGER = '00000000-0000-7000-8000-0000000004c1';

  const like = (postId: string, userId: string): Like => ({
    postId,
    userId,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  });

  const seeded = () =>
    memoryRepo(likes, [like(POST_A, USER_A), like(POST_A, USER_B), like(POST_B, USER_A)]);

  const keysLeft = async (): Promise<string[]> =>
    (await seeded().findMany({ limit: 10 })).rows.map((row) => `${row.postId}/${row.userId}`);

  test('an unfiltered delete is refused by both drivers, before any statement', async () => {
    await expect(seeded().deleteWhere({})).rejects.toBeUltimateError('X_WRITE_UNFILTERED');
    await expect(postgresRepo(likes).deleteWhere({})).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    // An `undefined` value is not a filter. `deleteWhere({ postId })` on a variable that came
    // back undefined has to land here, not on `delete from "pg_test_likes"` unqualified.
    await expect(postgresRepo(likes).deleteWhere({ postId: undefined })).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    expect(client.statements).toHaveLength(0);
  });

  test('a filter matching nothing removes nothing and reports 0', async () => {
    const memory = seeded();
    expect(await memory.deleteWhere({ postId: POST_A, userId: STRANGER })).toBe(0);
    expect((await memory.findMany({ limit: 10 })).rows).toHaveLength(3);

    client.on('delete from', { affected: 0 });
    expect(await postgresRepo(likes).deleteWhere({ postId: POST_A, userId: STRANGER })).toBe(0);
  });

  test('a composite-key row goes by its full key, and takes no neighbour with it', async () => {
    const memory = seeded();
    expect(await memory.deleteWhere({ postId: POST_A, userId: USER_A })).toBe(1);
    expect((await memory.findMany({ limit: 10 })).rows.map((row) => row.userId)).toEqual([
      USER_B,
      USER_A,
    ]);
    // The seed is rebuilt per repo, so the untouched store still holds all three.
    expect(await keysLeft()).toHaveLength(3);
  });

  test('a partial filter removes every row it matches', async () => {
    const memory = seeded();
    expect(await memory.deleteWhere({ postId: POST_A })).toBe(2);
    expect((await memory.findMany({ limit: 10 })).rows.map((row) => row.postId)).toEqual([POST_B]);
  });

  test('a filter cannot reach another tenant, in either driver', async () => {
    const theirs: Invoice = { ...ROW, id: `${ID.slice(0, -1)}9`, orgId: OTHER_ORG };
    const memory = memoryRepo(invoices, [ROW, theirs]);

    // Same reference on both rows: the filter matches two and the org predicate reaches one.
    expect(await memory.deleteWhere({ reference: 'INV-1' }, { orgId: ORG })).toBe(1);
    expect(await memory.count({ orgId: ORG })).toBe(0);
    expect(await memory.count({ orgId: OTHER_ORG })).toBe(1);

    // And with no tenant at all it never becomes a query in the first place.
    await expect(memory.deleteWhere({ reference: 'INV-1' })).rejects.toBeUltimateError(
      'X_TENANCY_UNSCOPED',
    );
    await expect(
      postgresRepo(invoices).deleteWhere({ reference: 'INV-1' }),
    ).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(client.statements).toHaveLength(0);
  });

  test('the generated delete binds every value and carries the org predicate', async () => {
    client.on('delete from', { affected: 1 });
    expect(await postgresRepo(likes).deleteWhere({ postId: POST_A, userId: USER_A })).toBe(1);
    expect(lastText()).toBe('delete from "pg_test_likes" where "post_id" = $1 and "user_id" = $2');
    expect(lastValues()).toEqual([POST_A, USER_A]);

    // A value that looks like SQL stays a parameter, exactly as it does on the read path.
    await postgresRepo(likes).deleteWhere({ postId: "x'; drop table pg_test_likes; --" });
    expect(lastText()).not.toContain('drop table');
    expect(lastText()).toBe('delete from "pg_test_likes" where "post_id" = $1');
    expect(lastValues()).toEqual(["x'; drop table pg_test_likes; --"]);
  });

  test('deleteWhere respects soft delete exactly as delete(id) does', async () => {
    client.on('update', { affected: 2 });
    expect(await postgresRepo(invoices).deleteWhere({ paid: false }, { orgId: ORG })).toBe(2);
    expect(lastText()).toStartWith('update "pg_test_invoices" set "deleted_at" = $1');
    expect(lastText()).toContain('"paid" = $2 and "org_id" = $3');
    // The stamp only lands on rows that have none — a second call cannot move it forward.
    expect(lastText()).toContain('"deleted_at" is null');
    expect(lastValues()[0]).toBeInstanceOf(Date);

    const memory = memoryRepo(invoices, [ROW]);
    expect(await memory.deleteWhere({ reference: 'INV-1' }, { orgId: ORG })).toBe(1);
    expect(await memory.deleteWhere({ reference: 'INV-1' }, { orgId: ORG })).toBe(0);
    const hidden = await memory.findMany({ orgId: ORG, includeDeleted: true });
    expect(hidden.rows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  test('delete(id) on a composite key now names a write, not a read', async () => {
    // The old message sent the reader to `findMany({ where })`, which cannot delete anything.
    await expect(postgresRepo(likes).delete(POST_A)).rejects.toThrow(/deleteWhere/);
    await expect(seeded().delete(POST_A)).rejects.toThrow(/deleteWhere/);
    expect(client.statements).toHaveLength(0);
  });

  test('update(id, patch) on a composite key names updateWhere too', async () => {
    await expect(postgresRepo(likes).update(POST_A, { userId: USER_B })).rejects.toThrow(
      /updateWhere/,
    );
    await expect(seeded().update(POST_A, { userId: USER_B })).rejects.toThrow(/updateWhere/);
    expect(client.statements).toHaveLength(0);
  });
});

describe('updateWhere(), in both drivers', () => {
  const CONV_A = '00000000-0000-7000-8000-0000000005a1';
  const CONV_B = '00000000-0000-7000-8000-0000000005b1';
  const USER_A = '00000000-0000-7000-8000-0000000006a1';
  const USER_B = '00000000-0000-7000-8000-0000000006b1';
  const STRANGER = '00000000-0000-7000-8000-0000000006c1';
  const READ_AT = new Date('2026-04-01T09:00:00.000Z');
  // Before the suite's frozen clock, so a stamp the framework writes is strictly later.
  const SEEDED_AT = new Date('2025-01-01T00:00:00.000Z');

  const like = (postId: string, userId: string): Like => ({
    postId,
    userId,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  });

  const seeded = () =>
    memoryRepo(likes, [like(CONV_A, USER_A), like(CONV_A, USER_B), like(CONV_B, USER_A)]);

  test('an empty filter and an empty patch are each refused, before any statement', async () => {
    await expect(seeded().updateWhere({}, { createdAt: READ_AT })).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    await expect(
      postgresRepo(likes).updateWhere({}, { createdAt: READ_AT }),
    ).rejects.toBeUltimateError('X_WRITE_UNFILTERED');
    // A forgotten variable on either argument lands on a refusal, never on a statement.
    await expect(
      postgresRepo(likes).updateWhere({ postId: undefined }, { createdAt: READ_AT }),
    ).rejects.toBeUltimateError('X_WRITE_UNFILTERED');
    await expect(seeded().updateWhere({ postId: CONV_A }, {})).rejects.toBeUltimateError(
      'X_PATCH_EMPTY',
    );
    await expect(
      postgresRepo(likes).updateWhere({ postId: CONV_A }, { createdAt: undefined }),
    ).rejects.toBeUltimateError('X_PATCH_EMPTY');
    // The unfiltered case wins when both are wrong: it is the one with the blast radius.
    await expect(postgresRepo(likes).updateWhere({}, {})).rejects.toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    expect(client.statements).toHaveLength(0);
  });

  test('a filter matching nothing writes nothing and reports 0', async () => {
    const memory = seeded();
    expect(
      await memory.updateWhere({ postId: CONV_A, userId: STRANGER }, { createdAt: READ_AT }),
    ).toBe(0);
    expect((await memory.findMany({ limit: 10 })).rows.map((row) => row.createdAt)).toEqual([
      SEEDED_AT,
      SEEDED_AT,
      SEEDED_AT,
    ]);

    client.on('update', { rows: [] });
    expect(
      await postgresRepo(likes).updateWhere(
        { postId: CONV_A, userId: STRANGER },
        { createdAt: READ_AT },
      ),
    ).toBe(0);
  });

  test('a composite-key row is patched by its full key, and takes no neighbour with it', async () => {
    const memory = seeded();
    expect(
      await memory.updateWhere({ postId: CONV_A, userId: USER_A }, { createdAt: READ_AT }),
    ).toBe(1);
    const rows = (await memory.findMany({ limit: 10 })).rows;
    expect(rows.filter((row) => row.createdAt.getTime() === READ_AT.getTime())).toHaveLength(1);
    expect(rows.find((row) => row.userId === USER_A && row.postId === CONV_A)?.createdAt).toEqual(
      READ_AT,
    );
  });

  test('a partial filter patches every row it matches', async () => {
    const memory = seeded();
    expect(await memory.updateWhere({ postId: CONV_A }, { createdAt: READ_AT })).toBe(2);
    const rows = (await memory.findMany({ limit: 10 })).rows;
    expect(rows.filter((row) => row.createdAt.getTime() === READ_AT.getTime())).toHaveLength(2);
    expect(rows.find((row) => row.postId === CONV_B)?.createdAt).not.toEqual(READ_AT);
  });

  test('a filter cannot reach another tenant, in either driver', async () => {
    const theirs: Invoice = { ...ROW, id: `${ID.slice(0, -1)}9`, orgId: OTHER_ORG };
    const memory = memoryRepo(invoices, [ROW, theirs]);

    expect(await memory.updateWhere({ reference: 'INV-1' }, { paid: true }, { orgId: ORG })).toBe(
      1,
    );
    expect((await memory.findMany({ orgId: ORG })).rows[0]?.paid).toBe(true);
    expect((await memory.findMany({ orgId: OTHER_ORG })).rows[0]?.paid).toBe(false);

    await expect(
      memory.updateWhere({ reference: 'INV-1' }, { paid: true }),
    ).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    await expect(
      postgresRepo(invoices).updateWhere({ reference: 'INV-1' }, { paid: true }),
    ).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
    expect(client.statements).toHaveLength(0);
  });

  test('the generated update binds every value and carries the org predicate', async () => {
    client.on('update', { rows: [physical({ paid: true })] });
    expect(
      await postgresRepo(invoices).updateWhere(
        { reference: 'INV-1' },
        { paid: true },
        { orgId: ORG },
      ),
    ).toBe(1);
    expect(lastText()).toBe(
      'update "pg_test_invoices" set "paid" = $1 where "reference" = $2 and "org_id" = $3' +
        ' and "deleted_at" is null returning *',
    );
    expect(lastValues()).toEqual([true, 'INV-1', ORG]);

    // A value that looks like SQL stays a parameter, on the set list as well as the filter.
    client.on('update', { rows: [] });
    await postgresRepo(invoices).updateWhere(
      { reference: "x'; drop table pg_test_invoices; --" },
      { note: "y'; drop table pg_test_invoices; --" },
      { orgId: ORG },
    );
    expect(lastText()).not.toContain('drop table');
    expect(lastText()).toStartWith(
      'update "pg_test_invoices" set "note" = $1 where "reference" = $2',
    );
    expect(lastValues().slice(0, 2)).toEqual([
      "y'; drop table pg_test_invoices; --",
      "x'; drop table pg_test_invoices; --",
    ]);
  });

  test('a soft-deleted row is not reachable, exactly as update(id, patch) cannot reach one', async () => {
    const memory = memoryRepo(invoices, [ROW]);
    await memory.delete(ID, { orgId: ORG });
    expect(await memory.updateWhere({ reference: 'INV-1' }, { paid: true }, { orgId: ORG })).toBe(
      0,
    );
    const hidden = await memory.findMany({ orgId: ORG, includeDeleted: true });
    expect(hidden.rows[0]?.paid).toBe(false);

    // The Postgres half of the same rule is the clause in the statement.
    client.on('update', { rows: [] });
    await postgresRepo(invoices).updateWhere(
      { reference: 'INV-1' },
      { paid: true },
      { orgId: ORG },
    );
    expect(lastText()).toContain('"deleted_at" is null');
  });

  test('onUpdateNow() columns are stamped through the table, exactly as update(id) stamps them', async () => {
    const db = database({ likes }, { driver: memoryDriver() });
    await db.likes.insert(like(CONV_A, USER_A));
    await db.likes.insert(like(CONV_B, USER_A));

    const before = (await db.likes.all()).map((row) => row.updatedAt.getTime());
    expect(await db.likes.updateWhere({ postId: CONV_A }, { createdAt: READ_AT })).toBe(1);

    const after = await db.likes.all();
    const patched = after.find((row) => row.postId === CONV_A);
    const untouched = after.find((row) => row.postId === CONV_B);
    expect(patched?.updatedAt.getTime()).toBeGreaterThan(before[0] ?? 0);
    expect(untouched?.updatedAt).toEqual(SEEDED_AT);

    // An empty patch is still `X_PATCH_EMPTY` through the table: `touch` must not launder "the
    // caller named no columns" into a write just because this entity declares `updatedAt`.
    await expect(db.likes.updateWhere({ postId: CONV_A }, {})).rejects.toBeUltimateError(
      'X_PATCH_EMPTY',
    );
  });
});
