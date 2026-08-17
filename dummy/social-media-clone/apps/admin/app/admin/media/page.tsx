// `/admin/media` — the uploads. `state` is the column the hourly sweep acts on, so the operator
// screen and the cron read the same fact: `pending` is waiting to be claimed, `orphan` is what the
// sweep already collected. `key` and never a URL — the bucket and the CDN host are deploy config.
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

const route = adminRouteFor(admin, `${admin.basePath}/media`);

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: route.policy,
  budget: { js: '0kb', lcp: 3000 },
  meta: () => ({ title: t('admin.media.title'), description: t('admin.media.description') }),
});

export async function Page() {
  const screen = await resourceScreen('media');
  return (
    <AdminShell titleKey={screen.titleKey} nav={visibleNavFor()} actorLabel={actorLabel()}>
      <ResourceView screen={screen} />
    </AdminShell>
  );
}
