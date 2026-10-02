// The ops board's one read of the database, with the decision in front of it. Split out of
// `ops.tsx` because it is logic, not markup: a gate asserted through a rendered document is
// asserted through a `.tsx` loader, and the property worth pinning is that the COUNT IS NEVER
// TAKEN — not that its digits are absent from the HTML.

import { db, schema } from '@social-media-clone/db';
import type { AdminDecision, CrudCtx } from '@ultimat3/admin';
import { adminRepoFor, decideAll, permissionsForOperation } from '@ultimat3/admin';

/**
 * The uploads breakdown, counted through the same adapter the media list reads through.
 *
 * UNGATED, deliberately and only here: the decision is `uploadsFor`'s, one function down, and it
 * is the only caller. A second caller must carry the same gate; there is no repo-level refusal to
 * fall back on.
 */
const mediaStateCounts = async (): Promise<Readonly<Record<string, number>>> => {
  const media = adminRepoFor(schema.media, db.media);
  const counts: Record<string, number> = {};
  for (const state of ['pending', 'attached', 'orphan'] as const) {
    counts[state] = (await media.count?.([{ field: 'state', op: 'eq', value: state }])) ?? 0;
  }
  return counts;
};

export interface Uploads {
  readonly decision: AdminDecision;
  /** `null`, never `{}`: "may not count" and "counted, and there are none" are different facts. */
  readonly counts: Readonly<Record<string, number>> | null;
}

/**
 * The uploads breakdown is a READ OF THE MEDIA TABLE, so it is decided by that table's own pair
 * and not by the page's `job:read`. `AdminPageProps.ctx` is required by the type precisely so this
 * decision has somewhere to come from; the counts used to be fetched before anything asked, which
 * made `/admin/ops` the one screen in the dashboard that answered about rows the actor had never
 * been allowed to list.
 */
export async function uploadsFor(ctx: CrudCtx): Promise<Uploads> {
  const decision = decideAll(ctx.authz, permissionsForOperation('media', 'list'), ctx.actor, {
    entity: 'media',
  });
  return { decision, counts: decision.allowed ? await mediaStateCounts() : null };
}
