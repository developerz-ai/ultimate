// `/admin/users`. Nothing about users is restated here: the columns, the filters, the validation
// and the labels all come from the `users` entity, and this file only says which resource to draw.

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
