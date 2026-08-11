// The authed dashboard. app/ streams: a static shell is flushed instantly and the holes arrive
// as their data resolves.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'visible',
  offline: 'runtime',
  // Auth is a policy, never a route-local flag: one authz system, evaluated everywhere.
  policy: { permission: 'dashboard:read' },
  budget: { js: '60kb', lcp: 2500 },
  meta: () => ({ title: t('app.dashboard.title'), description: t('app.dashboard.description') }),
});

export function DashboardPage() {
  return (
    <section class={styles.panel}>
      <h1>{t('app.dashboard.title')}</h1>
    </section>
  );
}
