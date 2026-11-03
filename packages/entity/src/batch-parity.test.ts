// The memory-vs-Postgres cross-check for `inBatches(size)`. `batch.test.ts` proves memory's own
// boundaries and, separately, the statement text the Postgres driver sends for one page; neither
// proves the two drivers cut the *same* seed into the *same* batches. This file seeds one row set
// into both and walks them side by side, so a boundary rule added to one driver and not the other
// shows up here first.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import {
  generateMigration,
  type PgliteClient,
  pgliteClient,
  type RecordingClient,
  raw,
  recordingClient,
  statementsOf,
} from '@ultimat3/db';
import type { BatchIterator } from './batch';
import { keyOf } from './batch-read';
import { integer, text, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';

const orgs = entity('batch_parity_orgs', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const posts = entity('batch_parity_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});

type Post = typeof posts.$row;

const ORG = '00000000-0000-7000-8000-0000000000b1';

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`;

const post = (index: number): Post => ({
  id: id(index),
  orgId: ORG,
  title: `Post ${index}`,
});

/** Six rows: divisible by 2 with nothing left over, and not divisible by 4 — one seed, two shapes. */
const SEED: readonly Post[] = Array.from({ length: 6 }, (_, index) => post(index));

/** Physical-cased, the same shape `batch.test.ts`'s own Postgres `describe` block builds by hand. */
const physical = (row: Post): Record<string, unknown> => ({
  id: row.id,
  org_id: row.orgId,
  title: row.title,
});

/**
 * The windows a real server would answer, call by call: each one asks for `size + 1` rows past the
 * last one served — the peek `pg-driver.ts` reads to decide whether a next cursor exists — and only
 * `size` of them are ever handed to a caller. Precomputing every window from the seed is what lets a
 * canned client answer a live walk without knowing SQL: the driver is real, only the network is not.
 */
const windowsFor = (rows: readonly Post[], size: number): readonly Post[][] => {
  const windows: Post[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    windows.push(rows.slice(index, index + size + 1));
  }
  return windows;
};

let client: RecordingClient;
let pg: ReturnType<typeof tableFor<Post, typeof posts.$columns>>;
let mem: ReturnType<typeof tableFor<Post, typeof posts.$columns>>;

beforeEach(() => {
  client = recordingClient();
  pg = tableFor(posts, postgresRepo(posts, { client }));
  mem = tableFor(posts, memoryRepo(posts, SEED));
});

afterAll(() => {
  clearRegistry();
});

/**
 * Drains the Postgres side against precomputed windows. `RecordingClient.on()` is "whatever
 * matches wins from here on", not a queue, so the next window is armed only once the generator is
 * about to ask for it — the same rhythm `batch.test.ts`'s own Postgres `describe` block uses.
 */
const drainPg = async (
  windows: readonly Post[][],
  batches: BatchIterator<Post>,
): Promise<readonly Post[][]> => {
  let index = 0;
  client.on('select', { rows: (windows[index] ?? []).map(physical) });
  const seen: Post[][] = [];
  for await (const batch of batches) {
    seen.push([...batch]);
    index += 1;
    const next = windows[index];
    if (next !== undefined) client.on('select', { rows: next.map(physical) });
  }
  return seen;
};

const drainMem = async (batches: BatchIterator<Post>): Promise<readonly Post[][]> => {
  const seen: Post[][] = [];
  for await (const batch of batches) seen.push([...batch]);
  return seen;
};

const idsOf = (batches: readonly Post[][]): readonly string[] =>
  batches.flat().map((row) => row.id);
const sizesOf = (batches: readonly Post[][]): readonly number[] =>
  batches.map((batch) => batch.length);

describe('memory and Postgres draw batch boundaries at the same place', () => {
  test.each([
    ['divides evenly', 2, [2, 2, 2]],
    ['does not divide evenly', 4, [4, 2]],
  ] as const)(
    'size %2$p (%1$s): identical sizes and identical row order',
    async (_label, size, expectedSizes) => {
      const windows = windowsFor(SEED, size);

      const fromMemory = await drainMem(mem.where({ orgId: ORG }).inBatches(size));
      const fromPostgres = await drainPg(windows, pg.where({ orgId: ORG }).inBatches(size));

      expect(sizesOf(fromMemory)).toEqual([...expectedSizes]);
      expect(sizesOf(fromPostgres)).toEqual(sizesOf(fromMemory));
      expect(idsOf(fromPostgres)).toEqual(idsOf(fromMemory));
      expect(idsOf(fromMemory)).toEqual(SEED.map((row) => row.id));
    },
  );

  test('the cursor after a partial walk resumes to the same row in both drivers', async () => {
    const size = 2;
    const windows = windowsFor(SEED, size);

    const memBatches = mem.where({ orgId: ORG }).inBatches(size);
    const firstMem: Post[] = [];
    for await (const batch of memBatches) {
      firstMem.push(...batch);
      break;
    }

    let index = 0;
    client.on('select', { rows: (windows[index] ?? []).map(physical) });
    const pgBatches = pg.where({ orgId: ORG }).inBatches(size);
    const firstPg: Post[] = [];
    for await (const batch of pgBatches) {
      firstPg.push(...batch);
      index += 1;
      const next = windows[index];
      if (next !== undefined) client.on('select', { rows: next.map(physical) });
      break;
    }

    // Both codecs are `cursor.ts`'s one implementation, so a cursor minted from the same plan and
    // the same last row is not merely equivalent — it is the same string.
    expect(pgBatches.cursor).toEqual(memBatches.cursor);
    expect(firstPg.map((row) => row.id)).toEqual(firstMem.map((row) => row.id));

    const restMem = await drainMem(
      mem.where({ orgId: ORG }).after(memBatches.cursor).inBatches(size),
    );
    const restPg = await drainPg(
      windows.slice(index),
      pg.where({ orgId: ORG }).after(pgBatches.cursor).inBatches(size),
    );

    expect(idsOf(restPg)).toEqual(idsOf(restMem));
    // Nothing repeated, nothing skipped: the two halves add back up to the whole seed, in order.
    expect([...firstMem.map((row) => row.id), ...idsOf(restMem)]).toEqual(
      SEED.map((row) => row.id),
    );
  });
});

/**
 * `keyOf` files a requested id and a returned key under one string. Postgres compares `bigint` and
 * `numeric` by value, so `'007'` matched the row and was filed apart from it: the statement found
 * it, and the caller was handed `null`.
 */
describe('a numeric key has one spelling', () => {
  test.each([
    ['bigint', '007', '7'],
    ['bigint', '+7', '7'],
    ['bigint', 7, '7'],
    ['bigint', 7n, '7'],
    ['bigint', '-0', '0'],
    ['integer', ' 42 ', '42'],
    ['numeric', '2.50', '2.5'],
    ['numeric', '+02.500', '2.5'],
    ['numeric', '.5', '0.5'],
    ['numeric', '5.', '5'],
    ['numeric', '-0.00', '0'],
    ['numeric', '1e3', '1000'],
    ['numeric', 1e21, '1000000000000000000000'],
    ['numeric', 2.5, '2.5'],
  ])('%s %p', (kind, value, expected) => {
    expect(keyOf(kind, value)).toBe(expected);
  });

  test.each([
    ['bigint', 'abc'],
    ['bigint', ''],
    ['bigint', '7.0'],
    ['bigint', '0x10'],
    ['integer', '1e3'],
    ['numeric', ''],
    ['numeric', '.'],
    ['numeric', 'abc'],
    ['numeric', '1e99999999'],
  ])('%s %p is filed as written, so Postgres answers its own refusal', (kind, value) => {
    expect(keyOf(kind, value)).toBe(value);
  });

  test('every other kind stays as it compares', () => {
    expect(keyOf('text', '007')).toBe('007');
    expect(keyOf('uuid', 'ABC')).toBe('abc');
  });
});

describe('findById under another spelling of the key, both drivers', () => {
  // A point read batches only inside a request's context: `coalesce.ts` keys on it.
  const inRequest = <T>(read: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), read);
  const bigs = entity('batch_key_bigs', {
    columns: { id: bigint().primaryKey(), label: text({ max: 8 }) },
  });
  const decimals = entity('batch_key_decimals', {
    columns: { id: decimal().primaryKey(), label: text({ max: 8 }) },
  });
  const ints = entity('batch_key_ints', {
    columns: { id: integer().primaryKey(), label: text({ max: 8 }) },
  });
  let pglite: PgliteClient;

  beforeAll(async () => {
    pglite = pgliteClient();
    const migration = generateMigration({
      entities: [bigs.$describe(), decimals.$describe(), ints.$describe()],
      name: 'batch key parity',
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await pglite.execute(raw(statement));
    await postgresRepo(bigs, { client: pglite }).insert({ id: '7', label: 'big' });
    await postgresRepo(decimals, { client: pglite }).insert({ id: '2.5', label: 'dec' });
    await postgresRepo(ints, { client: pglite }).insert({ id: 7, label: 'int' });
  }, 30_000);

  afterAll(async () => {
    await pglite.close();
  });

  for (const name of ['memory', 'postgres'] as const) {
    const bigRepo = () =>
      name === 'postgres'
        ? postgresRepo(bigs, { client: pglite })
        : memoryRepo(bigs, [{ id: '7', label: 'big' }]);
    const decimalRepo = () =>
      name === 'postgres'
        ? postgresRepo(decimals, { client: pglite })
        : memoryRepo(decimals, [{ id: '2.5', label: 'dec' }]);

    test.each(['007', '+7', '7'])(`${name} · bigint %p, alone`, async (id) => {
      const row = await inRequest(() => bigRepo().findById(id));
      expect(row?.label).toBe('big');
    });

    test(`${name} · bigint, three spellings batched in one tick`, async () => {
      const repo = bigRepo();
      const rows = await inRequest(() =>
        Promise.all([repo.findById('007'), repo.findById('+7'), repo.findById('7')]),
      );
      expect(rows.map((row) => row?.label)).toEqual(['big', 'big', 'big']);
    });

    test.each(['2.5', '2.50', '+02.500'])(`${name} · decimal %p, alone`, async (id) => {
      const row = await inRequest(() => decimalRepo().findById(id));
      expect(row?.label).toBe('dec');
    });
  }

  test('postgres · integer, a string spelling', async () => {
    const repo = postgresRepo(ints, { client: pglite });
    const row = await inRequest(() => repo.findById('007'));
    expect(row?.label).toBe('int');
  });

  test("postgres · a key the column cannot hold is the server's own refusal", async () => {
    const repo = postgresRepo(bigs, { client: pglite });
    const refused = await inRequest(() => repo.findById('abc')).catch((error: unknown) => error);
    expect((refused as { code?: unknown }).code).toBe('X_DB_STATEMENT_FAILED');
  });
});
