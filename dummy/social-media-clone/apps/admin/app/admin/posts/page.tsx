// `/admin/posts`. A soft-deleted post is absent by construction — the memory and Postgres repos
// both hide `deletedAt IS NOT NULL` rows from every read — so the seeded `post:deleted` never
// appears here, which is the entity's own rule and not a filter this file applies.
//
// The gate is the admin route table's, through `adminRouteFor()`: one URL, one permission
// declaration. See `users/page.tsx` for why.

import { adminRouteFor } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { admin } from '../admin';
import { actorLabel } from '../label';
import { resourceScreen, visibleNavFor } from '../screen';
import { AdminShell, ResourceView } from '../views';

const route = adminRouteFor(admin, `${admin.basePath}/posts`);

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: route.policy,
  budget: { js: '0kb', lcp: 3000 },
  meta: () => ({ title: t('admin.posts.title'), description: t('admin.posts.description') }),
});

export async function Page() {
  const screen = await resourceScreen('posts');
  return (
    <AdminShell titleKey={screen.titleKey} nav={visibleNavFor()} actorLabel={actorLabel()}>
      <ResourceView screen={screen} />
    </AdminShell>
  );
}
