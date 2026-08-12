// The inbox and its unread count. `ssr`, `hydrate: 'never'`, 0kb — the pinned
// solid-js@2.0.0-experimental.16 publishes no DOM renderer, so there is no client to run
// `useMutation(markNotificationsRead)` and the badge is rendered once, on the server.
//
// The count is DERIVED (`readAt is null`), never stored and never decremented, which is the same
// property that makes the offline twin in `mutator.ts` safe to replay.

import { actorOf } from '@ultimat3/action';
import { useContext } from '@ultimat3/core';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { iconBell } from '@ultimat3/ui/icons/bell';
import { AppShell } from '../../shared/ui/app-shell';
import { EmptyState } from '../../shared/ui/empty-state';
import { PageHeading } from '../../shared/ui/page-heading';
import styles from './page.module.scss';
import { inboxFor } from './service';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  policy: { permission: 'notification:read' },
  budget: { js: '0kb', lcp: 2000 },
  // An authed screen is never indexable — see app/messages/page.tsx.
  meta: () => ({
    title: t('app.notifications.title'),
    description: t('app.notifications.description'),
    robots: { index: false },
  }),
});

export async function Page(props: { readonly url?: string | undefined }) {
  const ctx = useContext();
  const viewer = actorOf(ctx);
  const inbox = viewer === null ? { items: [], unread: 0 } : await inboxFor(viewer.id);

  return (
    <AppShell url={props.url}>
      <PageHeading
        title={t('app.notifications.title')}
        lede={t('app.notifications.description')}
        actions={
          <span class={inbox.unread > 0 ? styles.countLive : styles.countQuiet}>
            {t('app.notifications.unread', { count: inbox.unread })}
          </span>
        }
      />

      {inbox.items.length === 0 ? (
        // The demo seed creates no notifications yet, so this is what the screen actually shows.
        <EmptyState
          glyph={iconBell}
          title={t('app.notifications.empty')}
          description={t('app.notifications.emptyHelp')}
        />
      ) : (
        <ul class={styles.list}>
          {inbox.items.map((item) => (
            <li class={item.readAt === null ? styles.new : styles.item}>
              <span class={styles.kind}>{t(`app.notifications.kind.${item.kind}`)}</span>
              <time class={styles.when} datetime={item.createdAt.toISOString()}>
                {stamp(item.createdAt, ctx.tz)}
              </time>
              <span class={styles.state}>
                {item.readAt === null
                  ? t('app.notifications.stateUnread')
                  : t('app.notifications.stateRead')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

/** Formatted with the request's zone, passed explicitly. There is no ambient default, anywhere. */
const stamp = (value: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    value,
  );
