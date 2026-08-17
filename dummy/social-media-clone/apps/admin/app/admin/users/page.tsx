// `/admin/users`. Nothing about users is restated here: the columns, the filters, the validation
// and the labels all come from the `users` entity, and this file only says which resource to draw.
//
// `policy` included. It is `adminRouteFor()`'s — the gate `defineAdmin()` composed for this exact
// URL from `permissionsForOperation('users', 'list')` — not a typed-in `'admin:read'` beside a
// route table that separately declares one. Two declarations of one URL's authz agree until
// somebody edits one of them, and nothing was ever going to notice.

import { adminRouteFor } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { admin } from '../admin';
import { actorLabel } from '../label';
import { resourceScreen, visibleNavFor } from '../screen';
import { AdminShell, ResourceView } from '../views';

const route = adminRouteFor(admin, `${admin.basePath}/users`);

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: route.policy,
  budget: { js: '0kb', lcp: 3000 },
  meta: () => ({ title: t('admin.users.title'), description: t('admin.users.description') }),
});

export async function Page() {
  const screen = await resourceScreen('users');
  return (
    <AdminShell titleKey={screen.titleKey} nav={visibleNavFor()} actorLabel={actorLabel()}>
      <ResourceView screen={screen} />
    </AdminShell>
  );
}
