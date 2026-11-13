// Every read and write the scheduled work makes. The jobs decide WHAT to do; this file decides HOW
// to ask. Only a repo.ts may touch `db` — a job importing it directly is X_BOUNDARY_VIOLATION.

import { DEMO_MARKER_IDS, db, type Media, seedDemo, seededRowIds } from '@social-media-clone/db';
import { expectedQueryLoop } from '@ultimat3/db';

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
 * One page of uploads marked orphan in ONE statement — it was one update per row, up to
 * `SWEEP_PAGE` a run (`repo.test.ts` pins the one). Convergent, not incremental: it SETS the state
 * rather than transitioning from an assumed one, so a replayed run over rows it already collected
 * writes the same value instead of double-counting. Resolves with how many rows it wrote.
 */
export const markOrphans = (ids: readonly string[]): Promise<number> =>
  ids.length === 0
    ? Promise.resolve(0)
    : db.media.andWhere('id', 'in', [...ids]).updateAll({ state: 'orphan' });

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
 * The content tables a visitor can add to, each read as a bounded page of rows and emptied of the
 * visitor's by one chain `deleteAll` over their ids — soft-deleting where the entity does, exactly
 * as `Table.delete(id)` did per row.
 *
 * `likes`, `friendships`, `blocks` and `participants` are absent and that is not an oversight: they
 * carry composite primary keys, and the reset keys its keep-set on `id`. The re-seed below leaves
 * the seeded rows of those tables exactly where they are — nothing deletes them — so what survives
 * a reset is join rows a visitor created, seeded ones included.
 */
const CONTENT_TABLES = [
  {
    table: 'media',
    ids: () => db.media.limit(PURGE_PAGE).all(),
    drop: (ids: string[]) => db.media.andWhere('id', 'in', ids).deleteAll(),
  },
  {
    table: 'comments',
    ids: () => db.comments.limit(PURGE_PAGE).all(),
    drop: (ids: string[]) => db.comments.andWhere('id', 'in', ids).deleteAll(),
  },
  {
    table: 'messages',
    ids: () => db.messages.limit(PURGE_PAGE).all(),
    drop: (ids: string[]) => db.messages.andWhere('id', 'in', ids).deleteAll(),
  },
  {
    table: 'notifications',
    ids: () => db.notifications.limit(PURGE_PAGE).all(),
    drop: (ids: string[]) => db.notifications.andWhere('id', 'in', ids).deleteAll(),
  },
  {
    table: 'posts',
    ids: () => db.posts.limit(PURGE_PAGE).all(),
    drop: (ids: string[]) => db.posts.andWhere('id', 'in', ids).deleteAll(),
  },
] as const;

/**
 * Purge the content tables, then replay the seed.
 *
 * Users and their auth rows (`x_users`, `x_sessions`) are deliberately NOT purged: an hourly reset that signs the
 * visitor out mid-click is worse than one that leaves their account alone, and the seed restores
 * every seeded user in place anyway.
 *
 * Two statements per table — the page read and one delete — where it was one delete per row, up
 * to 5 × PURGE_PAGE (`repo.test.ts`). No checkpoint: a cancelled attempt re-reads what is still
 * there rather than redoing what it already deleted, because `entry.ids()` runs again on the retry.
 */
export const restoreSeededGraph = async (): Promise<readonly PurgeCount[]> => {
  // What the fixture owns, so the purge removes what VISITORS added and nothing else. It used to
  // delete every row and count on the replay to put the seeded ones back, which worked only on the
  // in-memory driver: `posts` and `comments` are soft-deletable, deleting one stamps it, and no
  // upsert can clear that stamp again (packages/entity/src/bulk-write.ts:219 spares the column, and
  // the memory driver refuses to address a stamped row at all). The first hourly reset would have
  // left the demo's feed empty for good — `apps/web/site/feed/service.test.ts` caught it.
  const seeded = await seededRowIds();
  const counts: PurgeCount[] = [];
  // One read and one delete per TABLE, never per row: the loop is over the five content tables
  // named above, a list fixed in this file, so its statement count cannot grow with the data.
  await expectedQueryLoop(
    'two statements per content table, five tables fixed in CONTENT_TABLES',
    async () => {
      for (const entry of CONTENT_TABLES) {
        const keep = seeded.get(entry.table) ?? new Set<string>();
        const ids = (await entry.ids()).map((row) => row.id).filter((id) => !keep.has(id));
        if (ids.length > 0) await entry.drop(ids);
        counts.push({ table: entry.table, removed: ids.length });
      }
    },
  );
  // The same seed `apps/web/api/index.ts` runs at boot, against the same driver. A replay is
  // `on conflict do nothing` (packages/entity/src/seed.ts:274), so it restores a seeded row that is
  // GONE and leaves one that is still here — including one a visitor or a job changed. Nothing
  // above deletes a seeded row, so this pass re-creates nothing today; it is what makes a reset
  // safe against a store that was emptied, and what makes a boot on a fresh database seed it.
  await seedDemo();
  return counts;
};
