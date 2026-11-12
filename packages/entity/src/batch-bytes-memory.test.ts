// `inBatches(10_000)` over 10,000 rows of ~10 KB on the memory driver: the first batch weighs
// ~100 MB, past `MAX_PAGE_BYTES`, so it is re-read at 5,000 and the sweep finishes in two batches
// rather than failing — the shape of the framework's own reindex and history reads.
// `pg-batch-bytes.live.test.ts` is the same claim on Postgres, statements counted.

import { afterAll, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { MAX_PAGE_BYTES } from './page-bytes';
import { clearRegistry } from './registry';

const ROWS = 10_000;
const BODY = 10 * 1024;

const notes = entity('batch_bytes_memory_notes', {
  columns: { id: uuid().primaryKey(), body: text() },
});

afterAll(() => clearRegistry());

const idOf = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

test('a 10,000-row inBatches over ~10 KB rows completes, halved once', async () => {
  expect(ROWS * BODY).toBeGreaterThan(MAX_PAGE_BYTES);
  const db = database({ notes }, { driver: memoryDriver() });
  // One string shared by every row: the store holds 10 KB, each page weighs its rows' share.
  const body = 'x'.repeat(BODY);
  await db.notes.insertAll(Array.from({ length: ROWS }, (_, n) => ({ id: idOf(n + 1), body })));
  const sizes: number[] = [];
  for await (const batch of db.notes.inBatches(ROWS)) sizes.push(batch.length);
  expect(sizes).toEqual([ROWS / 2, ROWS / 2]);
});
