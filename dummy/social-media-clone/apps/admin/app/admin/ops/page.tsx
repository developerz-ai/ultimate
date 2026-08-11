// `/admin/ops` — the page no generator would have written, and the reason "easy custom pages" is a
// claim this app can show rather than assert. It is a plain route file with its own stylesheet, it
// reaches the SAME `pageDecision` gate every generated screen uses, and it renders three facts a
// CRUD table cannot: the cron schedule with its zone, the uploads breakdown the sweep acts on, and
// the demo-reset cadence.
//
// Nothing here re-derives anything. The schedule is `registeredTasks()` — the exact table
// `x tasks list --json` prints — so the page and the CLI can never disagree.

import { t } from '@ultimat3/i18n';
import { registeredTasks } from '@ultimat3/jobs';
import { defineRoute } from '@ultimat3/render';
import { actorLabel } from '../label';
import { mediaStateCounts } from '../repo';
import { pageDecision, visibleNavFor } from '../screen';
import { AdminShell } from '../views';
import shell from '../views.module.scss';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  policy: { permission: 'admin:read' },
  budget: { js: '0kb', lcp: 3000 },
  meta: () => ({ title: t('admin.ops.title'), description: t('admin.ops.description') }),
});

export async function Page() {
  const decision = pageDecision('job');
  const tasks = decision.allowed ? registeredTasks().map((handle) => handle.describe()) : [];
  const counts = decision.allowed ? await mediaStateCounts() : {};

  return (
    <AdminShell titleKey="admin.ops.title" nav={visibleNavFor()} actorLabel={actorLabel()}>
      {decision.allowed ? (
        <div class={styles.board}>
          <section class={styles.card}>
            <h2 class={styles.cardTitle}>{t('admin.ops.uploads')}</h2>
            <dl class={styles.stats}>
              {Object.entries(counts).map(([state, count]) => (
                <div class={styles.stat} data-state={state}>
                  <dt>{t(`admin.media.state.${state}`)}</dt>
                  <dd>{String(count)}</dd>
                </div>
              ))}
            </dl>
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
      ) : (
        <p class={shell.refusal}>
          {t('admin.denied.body', { permission: decision.permission, reason: decision.reason })}
        </p>
      )}
    </AdminShell>
  );
}
