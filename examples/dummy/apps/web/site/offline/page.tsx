/**
 * The offline fallback. Required by `app.config.ts` — omitting `pwa.offline.fallback` is a
 * compile error, because a PWA without one shows the browser's dinosaur, and a dinosaur reads as
 * "this app is broken" rather than "you are offline".
 *
 * It lives in `site/` so it is 0kb, precached with the shell, and renders from cache with no
 * network, no session, and no database.
 */

import { useT } from '@postly/i18n';
import { defineRoute } from '@ultimat3/render';
import { Stack } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  /**
   * measured: 0 B (2026-09-22; `x build --target static`, `.x/build-stats.json`'s `/offline` row).
   * why: lowered from 8kb — the page ships no island since its queue count left (an unscoped
   * document can open no member's outbox), and a budget above what the page costs hides the next
   * regression. `/x-sw-register.js` is the framework's and exempt (`FRAMEWORK_SCRIPTS`).
   */
  budget: { js: '0kb', lcp: 1000 },
  meta: ({ t }) => ({
    title: t('site.offline.metaTitle'),
    description: t('site.offline.metaDescription'),
    /**
     * Under `meta`, where `RouteMeta.robots` lives (`packages/seo/src/meta.ts`). It sat at the top
     * level of the route until 2026-08, which `RouteDefinition` does not declare — so the document
     * this page renders carried no robots directive at all.
     */
    robots: { index: false },
  }),
});

export function Page(): JSX.Element {
  const t = useT();
  return (
    <main class={styles.page}>
      <Stack gap={4}>
        <h1>{t('site.offline.heading')}</h1>
        <p>{t('site.offline.body')}</p>

        {/*
          No count. This document is precached and shared, so it is UNSCOPED — rendered for nobody
          (`ClientScope`, `@ultimat3/core`) — and an unscoped page can open no member's outbox by
          design: guessing a principal is how one visitor's queue reads into another's. It said
          "Nothing is waiting to send" on every render, which was false whenever a like was queued;
          the member's own pages say it where it is known (the feed row's queued notice).
        */}
        <p class={styles.queue}>{t('site.offline.queue')}</p>

        {/* A plain link: retrying is a navigation, and navigation works without a framework. */}
        <a class={styles.retry} href="/feed">
          {t('common.retry')}
        </a>
      </Stack>
    </main>
  );
}
