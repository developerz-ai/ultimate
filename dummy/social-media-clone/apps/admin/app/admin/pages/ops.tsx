// `/admin/ops` — the page no generator would have written, declared as a `pages:` entry so the
// frame owns its route and its authz. An ORDINARY component: there is no `defineRoute` here and no
// permission check either, deliberately. `pages:` is what puts it in the admin's route table and
// `guardedPage()` is what decides it, and `AdminPageProps.ctx` is required by the type, so the
// wrapper cannot be stepped around by calling this function directly.
//
// It renders three facts a CRUD table cannot: the cron schedule with its zone, the uploads
// breakdown the sweep acts on, and the demo-reset cadence. Nothing here re-derives anything — the
// schedule is `registeredTasks()`, the exact table `x tasks list --json` prints, so the page and
// the CLI can never disagree.

import type { AdminCustomPage, AdminPageProps } from '@ultimat3/admin';
import { t } from '@ultimat3/i18n';
import { registeredTasks } from '@ultimat3/jobs';
import type { JSX } from 'solid-js';
import styles from './ops.module.scss';
import { uploadsFor } from './uploads';

export async function OpsPage(props: AdminPageProps): Promise<JSX.Element> {
  const tasks = registeredTasks().map((handle) => handle.describe());
  // Decided before it is counted — `uploads.ts` owns both halves, and `props.ctx` is where the
  // decision comes from. This page renders the answer; it does not re-derive it.
  const uploads = await uploadsFor(props.ctx);

  return (
    <div class={styles.board}>
      <section class={styles.card}>
        <h2 class={styles.cardTitle}>{t('admin.ops.uploads')}</h2>
        {uploads.counts === null ? (
          <p class={styles.refusal}>
            {t('admin.denied.body', {
              permission: uploads.decision.permission,
              reason: uploads.decision.reason,
            })}
          </p>
        ) : (
          <dl class={styles.stats}>
            {Object.entries(uploads.counts).map(([state, count]) => (
              <div class={styles.stat} data-state={state}>
                <dt>{t(`admin.media.state.${state}`)}</dt>
                <dd>{String(count)}</dd>
              </div>
            ))}
          </dl>
        )}
        <p class={styles.hint}>{t('admin.ops.uploadsHint')}</p>
      </section>

      <section class={styles.card}>
        <h2 class={styles.cardTitle}>{t('admin.ops.schedule')}</h2>
        <ul class={styles.schedule}>
          {tasks.map((descriptor) => (
            <li class={styles.entry}>
              <span class={styles.entryName}>{descriptor.name}</span>
              <code class={styles.cron}>{descriptor.cron}</code>
              {/* The zone is on screen because an unzoned cron is a bug waiting for March. */}
              <span class={styles.zone}>{descriptor.tz}</span>
              <span class={styles.enqueues}>
                {t('admin.ops.enqueues', { jobs: descriptor.jobs.join(', ') })}
              </span>
            </li>
          ))}
        </ul>
        <p class={styles.hint}>{t('admin.ops.scheduleHint')}</p>
      </section>
    </div>
  );
}

/**
 * `job:read` is the page's own permission; `pagePermissions()` composes `admin:read` in front of
 * it, which is the same pair `permissionsForOperation('job', 'list')` builds for the jobs screen —
 * so the ops board and the jobs board are decided by one rule and not by two that agree today.
 * `navGroup` is what puts it in the sidebar: an operator who cannot open it does not see the link,
 * because `visibleNav` filters on these very permissions.
 */
export const opsPage: AdminCustomPage = {
  path: '/ops',
  titleKey: 'admin.ops.title',
  navGroup: 'admin.group.operations',
  // At least one, never empty: an empty list is X_ADMIN_PAGE_UNGUARDED at declaration time, which
  // is the whole reason the permission is a required field and not an optional one.
  permissions: ['job:read'],
  component: OpsPage,
};
