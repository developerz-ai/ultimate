/**
 * The posts slice's WINDOWED listing reads — a `repo` module beside `repo.ts`, split off for size:
 * whole `posts` rows (RECORDS, not views — what the page's store holds under `posts:<id>`), read as
 * the window `from()` hands a query's provider, so the cursor is pushed down to Postgres.
 */

import { db, type Post } from '@postly/db';
import type { OrgId } from '@postly/domain';
import { assert } from '@ultimat3/core';
import type { RowWindow } from '@ultimat3/query';

/**
 * `recentWindow` is the window `from()` hands `orgPosts`' provider (`RowWindow`): the cursor is
 * pushed down here, so page two is read past page one rather than cut from the same newest 50.
 *
 * The cursor's `Date` is a MILLISECOND and `created_at` keeps microseconds (`now()`), so every
 * seek here is on whole milliseconds — `[ms, ms + 1)` — exactly the order `from()` re-sorts and
 * cuts in. Seeking on the `Date` itself skipped every row with a non-zero microsecond.
 */
export const recentWindow = async (orgId: OrgId, window: RowWindow): Promise<readonly Post[]> => {
  // `orgPosts`' whole listing is its newest 50, so a provider handed no window reads that many.
  const take = window.limit ?? 50;
  const inOrg = db.posts.where({ orgId });
  const newest = (below: Date | null) =>
    (below === null ? inOrg : inOrg.andWhere('createdAt', 'lt', below))
      .orderBy('createdAt', 'desc')
      .orderBy('id')
      .limit(take)
      .all();
  if (window.after === null) return wholeLastMilli(orgId, await newest(null), take);
  const at = window.after.key[0];
  assert(
    at instanceof Date,
    `orgPosts' cursor carries ${typeof at} where its createdAt instant should be`,
    'page orgPosts with the nextCursor its previous page answered — never a hand-built cursor',
  );
  // The cursor's own millisecond, past its id — then everything older, completed to a whole one.
  const ties = await inOrg
    .andWhere('createdAt', 'gte', at)
    .andWhere('createdAt', 'lt', new Date(at.getTime() + 1))
    .andWhere('id', 'gt', window.after.id)
    .orderBy('id')
    .limit(take)
    .all();
  return [...ties, ...(await wholeLastMilli(orgId, await newest(at), take))];
};

/**
 * A full window may end inside a millisecond — Postgres cut it by microsecond, `from()` re-sorts
 * it by `(ms, id)` — so the rest of that millisecond is read too, and `from()`'s cut lands right.
 */
const wholeLastMilli = async (
  orgId: OrgId,
  rows: readonly Post[],
  take: number,
): Promise<readonly Post[]> => {
  const last = rows[rows.length - 1];
  if (last === undefined || rows.length < take) return rows;
  const held = new Set(rows.map((row) => row.id));
  const rest = await db.posts
    .where({ orgId })
    .andWhere('createdAt', 'gte', last.createdAt)
    .andWhere('createdAt', 'lt', new Date(last.createdAt.getTime() + 1))
    .all();
  return [...rows, ...rest.filter((row) => !held.has(row.id))];
};
