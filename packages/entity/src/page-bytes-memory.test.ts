// The page byte bound on the memory driver, through the chain an app writes: 65 rows of 1 MiB
// pass `MAX_PAGE_BYTES` and are refused as one page, while the same read narrowed with `select()`
// or a smaller `limit()` is answered — the two edits the refusal names. `pg-page-bytes.live.test.ts`
// is the same claim on Postgres.

import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { MAX_PAGE_BYTES } from './page-bytes';
import { clearRegistry } from './registry';

const MIB = 1024 * 1024;
const HEAVY_ROWS = Math.ceil(MAX_PAGE_BYTES / MIB) + 1;

const docs = entity('page_bytes_memory_docs', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }), body: text() },
});

afterAll(() => clearRegistry());

const idOf = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('memory · a page past MAX_PAGE_BYTES', () => {
  // One string shared by every row: the store holds 1 MiB, the page weighs `HEAVY_ROWS` of it.
  const body = 'x'.repeat(MIB);
  const db = database({ docs }, { driver: memoryDriver() });

  test('is refused as X_ENTITY_PAGE_TOO_LARGE, naming select() and limit()', async () => {
    await db.docs.insertAll(
      Array.from({ length: HEAVY_ROWS }, (_, n) => ({ id: idOf(n + 1), title: `doc ${n}`, body })),
    );
    const error = await db.docs
      .limit(HEAVY_ROWS)
      .all()
      .then(
        () => expect.unreachable(`${HEAVY_ROWS} MiB came back as one page`),
        (thrown: unknown) => thrown,
      );
    expect(error).toMatchObject({ code: 'X_ENTITY_PAGE_TOO_LARGE' });
    const { fix } = error as { fix: string };
    expect(fix).toContain('.select({ id: true, title: true })');
    // The fix as written, pasted onto the same read: it answers.
    const fields = /\.select\(\{ (.*?) \}\)/.exec(fix)?.[1] ?? '';
    const picked = Object.fromEntries(fields.split(', ').map((pair) => [pair.split(':')[0], true]));
    const rows = await db.docs
      .select(picked as { id: true; title: true })
      .limit(HEAVY_ROWS)
      .all();
    expect(rows.map((row) => Object.keys(row).sort())[0]).toEqual(['id', 'title']);
  });

  test('is answered narrowed by select() or a smaller limit()', async () => {
    const narrow = await db.docs.select({ id: true, title: true }).limit(HEAVY_ROWS).all();
    expect(narrow).toHaveLength(HEAVY_ROWS);
    expect(await db.docs.limit(50).all()).toHaveLength(50);
  });
});
