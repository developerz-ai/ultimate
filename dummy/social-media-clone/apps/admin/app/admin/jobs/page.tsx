// `/admin/jobs` — the queue's declarations: what can run, on which queue, with what retry policy.
//
// `describeJobs()` is read HERE and not stored on the `AdminApp`: the registry is filled by
// `apps/web/api/tasks.ts` handing its module to `defineApi`, and nothing promises that ran before
// this module was imported. A snapshot taken at `defineAdmin()` time would be empty on some boots
// and full on others, which is the worst kind of correct.
//
// The gate below is `adminRouteFor()`'s — the coarse half of the `permissionsForOperation('job',
// 'list')` pair `defineAdmin()` declared for this URL. `pageDecision('job')` is the fine half of
// that same pair, and both now trace back to one declaration in `admin.ts`.

import { adminRouteFor } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';
import { describeJobs } from '@ultimat3/jobs';
import { defineRoute } from '@ultimat3/render';
import { admin } from '../admin';
import { actorLabel } from '../label';
import { pageDecision, visibleNavFor } from '../screen';
import { AdminShell } from '../views';
import styles from '../views.module.scss';

const route = adminRouteFor(admin, `${admin.basePath}/jobs`);

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: route.policy,
  budget: { js: '0kb', lcp: 3000 },
  meta: () => ({ title: t('admin.jobs.title'), description: t('admin.jobs.description') }),
});

export function Page() {
  const decision = pageDecision('job');
  const jobs = decision.allowed ? describeJobs() : [];

  return (
    <AdminShell titleKey="admin.jobs.title" nav={visibleNavFor()} actorLabel={actorLabel()}>
      {decision.allowed ? (
        <table class={styles.table}>
          <thead>
            <tr>
              <th>{t('admin.jobs.name')}</th>
              <th>{t('admin.jobs.queue')}</th>
              <th>{t('admin.jobs.attempts')}</th>
              <th>{t('admin.jobs.backoff')}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((jobDescriptor) => (
              <tr>
                <td class={styles.mono}>{jobDescriptor.name}</td>
                <td>{jobDescriptor.queue}</td>
                <td>{String(jobDescriptor.retry.attempts)}</td>
                <td>{jobDescriptor.retry.backoff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class={styles.refusal}>
          {t('admin.denied.body', { permission: decision.permission, reason: decision.reason })}
        </p>
      )}
    </AdminShell>
  );
}
