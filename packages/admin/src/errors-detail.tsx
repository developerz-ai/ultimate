// `/admin/errors/:fingerprint`: one group — its counts, its status and the redacted sample the sink
// kept. Instants are printed as the ISO text the store holds (UTC, said so), never formatted in an
// ambient zone. A fingerprint with no group is a not-found body, not a blank page.

import { t } from '@ultimat3/i18n';
import { Card, Link } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './admin.module.scss';
import type { ErrorGroupsStore } from './error-groups-store';
import { jsonText } from './json-text';

export async function ErrorsDetail(props: {
  readonly store: ErrorGroupsStore;
  readonly listPath: string;
  readonly fingerprint: string;
}): Promise<JSX.Element> {
  const group = await props.store.get(props.fingerprint);
  if (group === undefined) {
    return (
      <Card>
        <p class="x-admin-empty">{t('admin.errors.missing')}</p>
        <Link href={props.listPath}>{t('admin.errors.back')}</Link>
      </Card>
    );
  }
  const { sample } = group;
  const facts: readonly (readonly [string, string])[] = [
    ['admin.errors.field.code', group.code],
    ['admin.errors.field.source', group.source],
    ['admin.errors.field.operation', group.operation ?? ''],
    ['admin.errors.field.status', t(`admin.errors.status.${group.status}`)],
    ['admin.errors.field.count', String(group.count)],
    ['admin.errors.field.first-seen', `${group.firstSeen} UTC`],
    ['admin.errors.field.last-seen', `${group.lastSeen} UTC`],
    ['admin.errors.field.release', sample.release ?? ''],
    ['admin.errors.field.environment', sample.environment],
    ['admin.errors.field.request', sample.requestId ?? ''],
    ['admin.errors.field.trace', sample.traceId ?? ''],
  ];
  return (
    <Card header={<h2 class={styles['mono']}>{group.fingerprint}</h2>}>
      <dl>
        {facts.map(([key, value]) => (
          <>
            <dt>{t(key)}</dt>
            <dd class={styles['mono']}>{value}</dd>
          </>
        ))}
      </dl>
      <h3>{sample.title}</h3>
      <p>{sample.cause}</p>
      <p>
        <code>{sample.fix}</code>
      </p>
      {sample.meta === null ? null : <pre class={styles['mono']}>{jsonText(sample.meta)}</pre>}
      {sample.stack === null ? null : <pre class={styles['mono']}>{sample.stack}</pre>}
      <Link href={props.listPath}>{t('admin.errors.back')}</Link>
    </Card>
  );
}
