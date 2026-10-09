import { tag } from '@postly/db';
import { orgId as toOrgId } from '@postly/domain';
import { from, query, t } from '@ultimat3/query';
import { feedRead } from '../policy';
import type { ActivitySummary } from '../repo';
import * as repo from '../repo';

/**
 * The feed's activity badge: how many posts this org has published, not live and not bundled
 * with `liveFeed` — its own read, its own cache tag, so `app/feed/page.tsx` can stream it in a
 * `<Suspense>` boundary independently of the rows, which arrive over the socket and never through
 * this client.
 */
export const feedActivity = query({
  input: t.object({ orgId: t.uuid }),
  policy: feedRead,
  cache: { tags: [tag.post], ttlMs: 60_000 },
  mcp: { expose: true, description: 'How many posts this org has published' },
  sql: ({ orgId }) =>
    from<ActivitySummary>('posts', () => repo.activitySummary(toOrgId(orgId)))
      .where({ orgId })
      .orderBy('orgId')
      .limit(1),
});
