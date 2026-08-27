// The offline fallback, and it is a ROUTE now rather than a component nothing rendered.
//
// It shipped as `app/offline.tsx` exporting `OfflineFallback`, which no module imported and no
// route table carried: `<name>.tsx` is not a route file (`registerRoute` enforces it), so `/offline`
// was never a URL and the service worker had nothing to fall back to. That is the same
// declared-and-never-wired shape as the worker itself (#390) — the fallback and the thing that
// serves it landed together, because neither is worth anything alone.
//
// `site/` and `render: 'static'`, deliberately: a fallback must render with no network, no session
// and no database, which is exactly what `site/` guarantees and what `app/` (ssr | stream) cannot.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { iconWifiOff } from '@ultimat3/ui/icons/wifi-off';
import type { JSX } from 'solid-js';
import { AppShell } from '../../shared/ui/app-shell';
import { EmptyState } from '../../shared/ui/empty-state';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  // `precache`, or the document that answers a lost network is itself fetched over the network.
  offline: 'precache',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1500 },
  meta: () => ({
    title: t('app.offline.title'),
    description: t('app.offline.description'),
    // A cached error page has nothing to index, and an indexed one outranks the page it stood in
    // for on the day the crawler happened to be offline.
    robots: { index: false },
  }),
});

export function Page(): JSX.Element {
  return (
    <AppShell>
      <h1 class={styles.title}>{t('app.offline.title')}</h1>
      <EmptyState
        glyph={iconWifiOff}
        title={t('app.offline.description')}
        description={t('app.offline.help')}
      />
    </AppShell>
  );
}
