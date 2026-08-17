// The ops board's one read of the database, with the decision in front of it. Split out of
// `ops.tsx` because it is logic, not markup: a gate asserted through a rendered document is
// asserted through a `.tsx` loader, and the property worth pinning is that the COUNT IS NEVER
// TAKEN — not that its digits are absent from the HTML.

import type { AdminDecision, CrudCtx } from '@ultimat3/admin';
import { decideAll, permissionsForOperation } from '@ultimat3/admin';
import { mediaStateCounts } from '../repo';

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
