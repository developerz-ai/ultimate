// `/admin` — the dashboard. `ssr`, not `spa`: the shell has data to render (the nav this actor may
// open, and the decision behind every operation), and a `spa` shell would ship that decision to the
// browser to be asked again. The component is `async` because a route has no `load` seam.
//
// The route's `policy` is the coarse gate; it is NOT what makes the dashboard view-only. That is
// `admin:read` without `admin:write`, decided per operation by `policy.ts` — one decision that both
// declines to render a control and refuses the call behind it.

import { adminRouteFor } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { currentAdminActor } from './actor';
import { admin } from './admin';
import { resourceScreen, visibleNavFor } from './screen';
import { AdminShell, ResourceView } from './views';
import styles from './views.module.scss';

const route = adminRouteFor(admin, admin.basePath);

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  // Auth is a policy, never a route-local flag. It also earns `private, no-store` from
  // `ssrHeaders` — an operator's rows must never be shared-cacheable. The permission itself is
  // read from the admin route table rather than typed here: one URL, one declaration.
  policy: route.policy,
  budget: { js: '0kb', lcp: 3000 },
  meta: () => ({ title: t('admin.home.title'), description: t('admin.home.description') }),
});

export async function Page() {
  const { actor } = currentAdminActor();
  const screens = await Promise.all(
    admin.resources.map((resource) => resourceScreen(resource.name, 5)),
  );

  return (
    <AdminShell
      titleKey="admin.home.title"
      nav={visibleNavFor()}
      actorLabel={
        actor === null
          ? t('admin.actor.anonymous')
          : t('admin.actor.signedIn', { id: actor.id, roles: (actor.roles ?? []).join(', ') })
      }
    >
      <p class={styles.note}>{t('admin.home.description')}</p>
      {screens.map((screen) => (
        <section class={styles.panel}>
          <h2 class={styles.title}>{t(screen.titleKey)}</h2>
          <ResourceView screen={screen} />
        </section>
      ))}
    </AdminShell>
  );
}
