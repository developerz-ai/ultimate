// Every read and write the scheduled work makes. The jobs decide WHAT to do; this file decides HOW
// to ask. Only a repo.ts may touch `db` — a job importing it directly is X_BOUNDARY_VIOLATION.

import { DEMO_MARKER_IDS, db, type Media, seedDemo, seededRowIds } from '@social-media-clone/db';

/**
 * A sweep is a job, not a table scan: it collects a bounded page per run and the next occurrence
 * takes the next one. An unbounded `all()` here is how an hourly cron becomes an incident the day
 * the uploads table gets interesting.
 */
export const SWEEP_PAGE = 200;

/** Bounded so a reset cannot walk an unbounded table either. Far above anything the seed writes. */
const PURGE_PAGE = 1_000;

/**
 * Uploads still waiting to be claimed, oldest first, that arrived before `before`.
 *
 * `state`, never `postId IS NULL`: "waiting to be claimed" and "abandoned" are different facts, and
 * the sweep has to tell them apart without guessing from a timestamp — which is exactly why
 * `media.state` is a column (packages/db/src/schema/media.ts:32).
 *
 * Ordered on `(createdAt asc, id)`: `createdAt` alone is a partial order, so two uploads written in
 * the same millisecond can swap between runs and one of them straddles the page boundary forever.
 */
export const pendingMediaBefore = (before: Date, limit = SWEEP_PAGE): Promise<readonly Media[]> =>
  db.media
    .where({ state: 'pending' })
    .andWhere('createdAt', 'lt', before)
    .orderBy('createdAt', 'asc')
    .orderBy('id')
    .limit(limit)
    .all();

/**
 * Convergent, not incremental: it SETS the state rather than transitioning from an assumed one, so
 * a replayed run over a row it already collected writes the same value instead of double-counting.
 */
export const markOrphan = (id: string): Promise<Media> => db.media.update(id, { state: 'orphan' });

export const mediaById = (id: string): Promise<Media | null> => db.media.where({ id }).one();

/**
 * Which of the demo's marker rows this store is missing — empty means "this is the demo's database".
 *
 * One statement, `in` over two deterministic ids, because the question is asked immediately before a
 * job deletes five tables. It answers "the seed ran here", never "the database is small" or "the
 * URL looks like a demo": those are guesses, and the thing being guarded is destruction.
 */
export const missingDemoMarkers = async (): Promise<readonly string[]> => {
  const rows = await db.users
    .andWhere('id', 'in', [...DEMO_MARKER_IDS])
    .limit(DEMO_MARKER_IDS.length)
    .all();
  const found = new Set(rows.map((row) => row.id));
  return DEMO_MARKER_IDS.filter((id) => !found.has(id));
};

/** What one reset removed, per table. Returned so the job's log names rows rather than "ok". */
export interface PurgeCount {
  readonly table: string;
  readonly removed: number;
}

/**
 * The content tables a visitor can add to, each addressed by a single `id`.
 *
 * `likes`, `friendships`, `blocks` and `participants` are absent and that is not an oversight: they
 * carry composite primary keys, so `Table.delete(id)` cannot name one — `singleKeyOf`
 * (packages/entity/src/plan.ts:16) refuses it — and `deleteWhere({})` is `X_DELETE_UNFILTERED`
 * rather than "every row". "Empty this join table" is therefore not expressible at all today. The
 * re-seed below still restores every seeded row of those tables — an insert overwrites by primary
 * key — so what survives a reset is join rows a visitor created, and nothing seeded.
 */
const CONTENT_TABLES = [
  {
    table: 'media',
    ids: () => db.media.limit(PURGE_PAGE).all(),
    drop: (id: string) => db.media.delete(id),
  },
  {
    table: 'comments',
    ids: () => db.comments.limit(PURGE_PAGE).all(),
    drop: (id: string) => db.comments.delete(id),
  },
  {
    table: 'messages',
    ids: () => db.messages.limit(PURGE_PAGE).all(),
    drop: (id: string) => db.messages.delete(id),
  },
  {
    table: 'notifications',
    ids: () => db.notifications.limit(PURGE_PAGE).all(),
    drop: (id: string) => db.notifications.delete(id),
  },
  {
    table: 'posts',
    ids: () => db.posts.limit(PURGE_PAGE).all(),
    drop: (id: string) => db.posts.delete(id),
  },
] as const;

/**
 * Purge the content tables, then replay the seed.
 *
 * Users, credentials and sessions are deliberately NOT purged: an hourly reset that signs the
 * visitor out mid-click is worse than one that leaves their account alone, and the seed restores
 * every seeded user in place anyway.
 *
 * One statement per row, up to 5 × PURGE_PAGE of them, and no checkpoint — deliberate, at this
 * size. A page is 1,000 and the demo's hour produces dozens, so the real pass is a few dozen
 * statements; a cancelled attempt re-reads what is still there rather than redoing what it already
 * deleted, because `entry.ids()` runs again on the retry. What would change that judgement is a
 * bulk delete this app can express: `deleteWhere` needs an equality filter and `deleteWhere({})` is
 * `X_WRITE_UNFILTERED`, so "empty this table" is not expressible today. Splitting the pass into a
 * `step.run` per table would checkpoint it — the cost is only worth paying when a page is full.
 */
export const restoreSeededGraph = async (): Promise<readonly PurgeCount[]> => {
  // What the fixture owns, so the purge removes what VISITORS added and nothing else. It used to
  // delete every row and count on the replay to put the seeded ones back, which worked only on the
  // in-memory driver: `posts` and `comments` are soft-deletable, deleting one stamps it, and no
  // upsert can clear that stamp again (packages/entity/src/bulk-write.ts:219 spares the column, and
  // the memory driver refuses to address a stamped row at all). The first hourly reset would have
  // left the demo's feed empty for good — `apps/web/app/posts/service.test.ts` caught it.
  const seeded = await seededRowIds();
  const counts: PurgeCount[] = [];
  for (const entry of CONTENT_TABLES) {
    const keep = seeded.get(entry.table) ?? new Set<string>();
    const rows = (await entry.ids()).filter((row) => !keep.has(row.id));
    for (const row of rows) await entry.drop(row.id);
    counts.push({ table: entry.table, removed: rows.length });
  }
  // The same seed `apps/web/api/index.ts` runs at boot, against the same driver. An insert
  // overwrites by primary key, so replaying it puts every seeded row back at its seeded value —
  // `media:orphan` included, which is what gives the next sweep something to collect.
  await seedDemo();
  return counts;
};
