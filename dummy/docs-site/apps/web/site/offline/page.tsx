// The offline fallback, and it is a ROUTE — `pwa.offline.fallback` in app.config.ts names this
// path, the generated sw.js precaches it, and every app/ route with offline: 'runtime' falls back
// here. So a train tunnel shows the product's own shell instead of the browser's error page.
//
// site/ and render: 'static', deliberately: the document that answers a lost network has to render
// with no network, no session and no database, which is what site/ guarantees and app/ (ssr |
// stream) cannot. `offline: 'precache'` for the same reason one level down — a fallback fetched
// over the network when the network is gone is not a fallback.

// `useT()`, not `t` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
import { useT } from '@docs-site/i18n';
import { defineRoute } from '@ultimat3/render';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: ({ t }) => ({
    title: t('app.offline.title'),
    description: t('app.offline.description'),
    // A cached error page has nothing to index, and an indexed one outranks the page it stood in
    // for on the day the crawler happened to be offline.
    robots: { index: false },
  }),
});

export function Page() {
  const t = useT();

  return (
    <main class={styles.offline}>
      <h1>{t('app.offline.title')}</h1>
      <p>{t('app.offline.description')}</p>
    </main>
  );
}
