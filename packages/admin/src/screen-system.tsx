// The two built-in screens that are neither a resource nor the jobs dashboard (`jobs/`): the
// audit trail and cross-entity search. Each is decided by its own route's permission pair through
// `decideAll` — the same gate a custom page gets — before anything is read.

import { t } from '@ultimat3/i18n';
import { Card } from '@ultimat3/ui';
import type { AdminApp, AdminRoute } from './admin';
import styles from './admin.module.scss';
import { operationLabel } from './detail';
import { type AdminScreen, guardedScreen } from './screen-frame';
import { adminSearch } from './search';

/** How many audit entries one screen shows — newest first, from whichever log the admin names. */
const AUDIT_PAGE = 100;

export function auditScreen(app: AdminApp, route: AdminRoute): AdminScreen {
  return guardedScreen(app, route, async () => {
    const entries = await app.audit.entries({ limit: AUDIT_PAGE });
    return (
      <Card>
        {entries.length === 0 ? (
          <p class="x-admin-empty">{t('admin.audit.empty')}</p>
        ) : (
          <ol class={styles['list']}>
            {entries.map((entry) => (
              <li>
                <code>{entry.at}</code> <span>{entry.actor.id}</span>{' '}
                <span>{operationLabel(entry)}</span>{' '}
                <span class={styles['mono']}>{entry.entity}</span>{' '}
                <span data-outcome={entry.outcome}>
                  {t(`admin.audit.outcome.${entry.outcome}`)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    );
  });
}

/** `?term=` — the shell's search box is a native GET at this route. */
export function searchScreen(app: AdminApp, route: AdminRoute): AdminScreen {
  return guardedScreen(app, route, async (request) => {
    const term = new URL(request.url).searchParams.get('term') ?? '';
    const result = await adminSearch({ term, resources: app.resources, ctx: request.ctx });
    return (
      <Card>
        {result.hits.length === 0 ? (
          <p class="x-admin-empty">{t('admin.list.empty')}</p>
        ) : (
          <ul class={styles['list']}>
            {result.hits.map((hit) => (
              <li>
                <a href={`${app.basePath}${hit.href}`}>{hit.label}</a>{' '}
                <span class={styles['mono']}>{hit.entity}</span>
              </li>
            ))}
          </ul>
        )}
        {result.skipped.map((skip) => (
          <p class={styles['note']}>
            <span class={styles['mono']}>{skip.entity}</span> {t(skip.reason)}
          </p>
        ))}
      </Card>
    );
  });
}
