// `/admin/posts`. A soft-deleted post is absent by construction — the memory and Postgres repos
// both hide `deletedAt IS NOT NULL` rows from every read — so the seeded `post:deleted` never
// appears here, which is the entity's own rule and not a filter this file applies.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { actorLabel } from '../label';
import { resourceScreen, visibleNavFor } from '../screen';
import { AdminShell, ResourceView } from '../views';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: { permission: 'admin:read' },
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
