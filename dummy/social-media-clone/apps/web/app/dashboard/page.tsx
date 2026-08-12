// The authed dashboard: the one screen that exists to point at the other four.
//
// It renders no data of its own on purpose. Every number worth showing here — unread messages,
// pending requests — is already a bounded, ordered read owned by the screen that shows it, and a
// second read of the same rows on this page would be a second answer that can disagree.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { Icon } from '@ultimat3/ui';
import { iconArrowRight } from '@ultimat3/ui/icons/arrow-right';
import { iconBell } from '@ultimat3/ui/icons/bell';
import { iconMessageSquare } from '@ultimat3/ui/icons/message-square';
import { iconRss } from '@ultimat3/ui/icons/rss';
import { iconUsers } from '@ultimat3/ui/icons/users';
import { AppShell } from '../../shared/ui/app-shell';
import { PageHeading } from '../../shared/ui/page-heading';
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

const DESTINATIONS = [
  { name: 'friends', href: '/friends', glyph: iconUsers },
  { name: 'messages', href: '/messages', glyph: iconMessageSquare },
  { name: 'notifications', href: '/notifications', glyph: iconBell },
  { name: 'feed', href: '/feed', glyph: iconRss },
] as const;

export function DashboardPage(props: { readonly url?: string | undefined }) {
  return (
    <AppShell url={props.url} width="wide">
      <PageHeading
        eyebrow={t('app.dashboard.eyebrow')}
        title={t('app.dashboard.title')}
        lede={t('app.dashboard.description')}
      />

      <ul class={styles.grid}>
        {DESTINATIONS.map((destination) => (
          <li>
            <a class={styles.card} href={destination.href}>
              <span class={styles.icon} aria-hidden="true">
                <Icon glyph={destination.glyph} />
              </span>
              <span class={styles.title}>{t(`app.dashboard.card.${destination.name}.title`)}</span>
              <span class={styles.body}>{t(`app.dashboard.card.${destination.name}.body`)}</span>
              <span class={styles.more} aria-hidden="true">
                <Icon glyph={iconArrowRight} />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
