// The memory-vs-Postgres cross-check for `inBatches(size)`. `batch.test.ts` proves memory's own
// boundaries and, separately, the statement text the Postgres driver sends for one page; neither
// proves the two drivers cut the *same* seed into the *same* batches. This file seeds one row set
// into both and walks them side by side, so a boundary rule added to one driver and not the other
// shows up here first.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient } from '@ultimat3/db';
import type { BatchIterator } from './batch';
import { text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

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
  client = createRecordingClient();
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
