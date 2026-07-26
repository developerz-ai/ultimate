/**
 * The authed shell. Flushed in the first streaming chunk, so it must not await anything: the
 * actor and their org come from the request context the framework already resolved.
 *
 * It also establishes the two things every page below depends on — the viewer (locale + zone)
 * and the theme attribute — so no page has to resolve them again.
 */

import { useT } from '@postly/i18n';
import { OrgSwitcher } from '@postly/ui';
import { useActor } from '@ultimat3/core';
import { AppUpdateBanner, ThemeProvider } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { viewerOf } from '../shared/viewer';
import styles from './layout.module.scss';
import { ViewerProvider } from './viewer-context';

export function Layout(props: { readonly children: JSX.Element }): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = () => viewerOf(actor.member);

  return (
    <ThemeProvider preference={actor.member.theme}>
      <ViewerProvider value={viewer()}>
        <div class={styles.shell}>
          <header class={styles.bar}>
            <a class={styles.brand} href="/feed">
              {t('common.appName')}
            </a>

            <nav class={styles.nav} aria-label={t('app.nav.org')}>
              <a href="/feed">{t('app.nav.feed')}</a>
              <a href="/settings">{t('app.nav.settings')}</a>
            </nav>

            <OrgSwitcher orgs={actor.orgs} currentOrgId={actor.orgId} action="/_x/session/org" />
          </header>

          {/* Version skew is a signal, not a 404: the user reloads when they choose to. */}
          <AppUpdateBanner label={t('errors.updateAvailable')} action={t('errors.updateAction')} />

          <main class={styles.main}>{props.children}</main>
        </div>
      </ViewerProvider>
    </ThemeProvider>
  );
}
