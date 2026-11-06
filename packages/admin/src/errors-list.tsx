// `/admin/errors`: every error group the sink folded, newest-seen first, one native GET form to
// pick a status. No script, no state: the URL is the screen (`?status=`), and a parameter this
// screen does not read is the list's 400, never the unfiltered list.

import { t } from '@ultimat3/i18n';
import { Badge, Card, Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import {
  ERROR_GROUP_STATUSES,
  type ErrorGroupStatus,
  type ErrorGroupsStore,
} from './error-groups-store';
import { AdminFilterInvalidError } from './errors';

/** `?status=` and nothing else; empty is "every status". */
export function errorsStatusOf(url: URL): ErrorGroupStatus | undefined {
  for (const key of url.searchParams.keys()) {
    if (key === 'status') continue;
    throw new AdminFilterInvalidError({
      entity: 'x_error_groups',
      asked: key,
      cause: 'is not a parameter of the error groups screen',
      known: ['status'],
    });
  }
  const asked = url.searchParams.get('status') ?? '';
  if (asked === '') return undefined;
  const status = ERROR_GROUP_STATUSES.find((known) => known === asked);
  if (status !== undefined) return status;
  throw new AdminFilterInvalidError({
    entity: 'x_error_groups',
    asked: `status=${asked}`,
    cause: 'is not a triage status',
    known: ERROR_GROUP_STATUSES.map((known) => `status=${known}`),
  });
}

export async function ErrorsList(props: {
  readonly store: ErrorGroupsStore;
  readonly basePath: string;
  readonly url: string;
}): Promise<JSX.Element> {
  const status = errorsStatusOf(new URL(props.url));
  const groups = await props.store.list(status === undefined ? {} : { status });
  return (
    <Card>
      <nav class={styles['filters']} aria-label={t('admin.errors.filter.status')}>
        <Link href={props.basePath}>{t('admin.filter.any')}</Link>{' '}
        {ERROR_GROUP_STATUSES.map((one) => (
          <Link href={`${props.basePath}?status=${one}`}>{t(`admin.errors.status.${one}`)}</Link>
        ))}
      </nav>
      {groups.length === 0 ? (
        <p class="x-admin-empty">{t('admin.errors.empty')}</p>
      ) : (
        <ol class={styles['list']}>
          {groups.map((group) => (
            <li data-fingerprint={group.fingerprint}>
              <a href={`${props.basePath}/${encodeURIComponent(group.fingerprint)}`}>
                <code>{group.code}</code>
              </a>{' '}
              <span>{group.message}</span>{' '}
              <span class={styles['mono']}>{group.operation ?? group.source}</span>{' '}
              <Badge>{t('admin.errors.count', { count: group.count })}</Badge>{' '}
              <span data-status={group.status}>{t(`admin.errors.status.${group.status}`)}</span>{' '}
              <code>{group.lastSeen}</code>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
