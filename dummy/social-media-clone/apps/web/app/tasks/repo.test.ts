// unit — the scheduled work's write counts. The sweep was one update per stale upload (≤ 200 a
// run) and the reset one delete per visitor row (≤ 5 × 1,000); each is one chain write now.

import { beforeEach, expect, test } from 'bun:test';
import { db, driver, seedDemo } from '@social-media-clone/db';
import { seedId } from '@ultimat3/entity';
import { testStatements } from '@ultimat3/testing';
import { markOrphans, mediaById, pendingMediaBefore, restoreSeededGraph } from './repo';

const VISITOR = seedId('user:user');
const BEFORE = new Date('2026-04-01T00:00:00.000Z');
const VISITS = 12;

beforeEach(async () => {
  driver.reset?.();
  await seedDemo();
});

/** The fingerprint of every write a block sent, in order — reads are not the question here. */
const writesDuring = async (work: () => Promise<unknown>): Promise<readonly string[]> => {
  // Disposal throws `X_N_PLUS_ONE_WRITE` for a per-row write — the loop these tests pin.
  using statements = await testStatements();
  await work();
  return statements
    .all()
    .filter((statement) => statement.kind === 'write')
    .map((statement) => statement.fingerprint);
};

test('the sweep marks a whole page orphan in one write', async () => {
  for (let index = 0; index < VISITS; index += 1) {
    await db.media.insert({
      ownerId: VISITOR,
      key: `visitor/${index}.png`,
      kind: 'image',
      contentType: 'image/png',
      bytes: 1,
      state: 'pending',
      createdAt: new Date('2026-03-15T00:00:00.000Z'),
    });
  }
  const stale = await pendingMediaBefore(BEFORE);
  expect(stale.length).toBeGreaterThan(VISITS);

  expect(await writesDuring(() => markOrphans(stale.map((row) => row.id)))).toEqual([
    'media.updateWhere',
  ]);
  expect(await pendingMediaBefore(BEFORE)).toHaveLength(0);
  // The control: an attached upload is never in the page, so it is never in the write.
  expect((await mediaById(seedId('media:tenancy-cover')))?.state).toBe('attached');
});

test('the reset removes visitor rows with one delete per table, seeded rows kept', async () => {
  const seededPosts = (await db.posts.limit(50).all()).length;
  for (let index = 0; index < VISITS; index += 1) {
    await db.posts.insert({
      authorId: VISITOR,
      body: `visitor post ${index}`,
      audience: 'public',
      likeCount: 0,
      commentCount: 0,
      mediaCount: 0,
    });
  }

  let purged: Awaited<ReturnType<typeof restoreSeededGraph>> = [];
  const writes = await writesDuring(async () => {
    purged = await restoreSeededGraph();
  });

  expect(purged.find((entry) => entry.table === 'posts')?.removed).toBe(VISITS);
  // One delete, for the one table a visitor wrote to; the seed replay's upserts beside it are
  // one per seeded table, never one per row.
  expect(writes.filter((fingerprint) => fingerprint.includes('.delete'))).toEqual([
    'posts.deleteWhere',
  ]);
  expect((await db.posts.limit(50).all()).length).toBe(seededPosts);
});
