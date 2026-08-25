/**
 * The offline fallback. Required by `app.config.ts` — omitting `pwa.offline.fallback` is a
 * compile error, because a PWA without one shows the browser's dinosaur, and a dinosaur reads as
 * "this app is broken" rather than "you are offline".
 *
 * It lives in `site/` so it is 0kb, precached with the shell, and renders from cache with no
 * network, no session, and no database.
 */

import { useT } from '@postly/i18n';
import { hasLiveClient, useMutationQueue } from '@ultimat3/realtime';
import { defineRoute } from '@ultimat3/render';
import { Stack } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  /**
   * The single exception to `hydrate: 'never'` on this surface: the queued-mutation count is the
   * one fact a person offline actually wants, and it comes from the local store, not the network.
   */
  hydrate: 'idle',
  budget: { js: '8kb', lcp: 1000 },
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
  /**
   * The queue count is client-only, and the guard is what makes this page prerenderable at all:
   * `useMutationQueue()` throws `X_LIVE_CLIENT_MISSING` when no `LiveClient` is registered, and
   * nothing registers one during a build — so `x build --target static` failed on THIS route and
   * emitted no page, for the whole app. `app/update-banner.tsx` carries the same guard for the
   * same reason: this component renders on a server as well as in a browser.
   *
   * The count stays in the page rather than moving into an island, because `{count}` is a CLDR
   * plural (`site.offline.queued_one` / `_other`): an island's props cross the seam as JSON that
   * is already translated, and a count only the browser knows cannot be pre-translated.
   */
  const pending = (): number => (hasLiveClient() ? useMutationQueue().pending : 0);

  return (
    <main class={styles.page}>
      <Stack gap={4}>
        <h1>{t('site.offline.heading')}</h1>
        <p>{t('site.offline.body')}</p>

        <p class={styles.queue}>
          <Show when={pending() > 0} fallback={<span>{t('site.offline.queuedNone')}</span>}>
            <span>{t('site.offline.queued', { count: pending() })}</span>
          </Show>
        </p>

        {/* A plain link: retrying is a navigation, and navigation works without a framework. */}
        <a class={styles.retry} href="/feed">
          {t('common.retry')}
        </a>
      </Stack>
    </main>
  );
}
