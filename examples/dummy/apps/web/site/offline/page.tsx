/**
 * The offline fallback. Required by `app.config.ts` — omitting `pwa.offline.fallback` is a
 * compile error, because a PWA without one shows the browser's dinosaur, and a dinosaur reads as
 * "this app is broken" rather than "you are offline".
 *
 * It lives in `site/` so it is 0kb, precached with the shell, and renders from cache with no
 * network, no session, and no database.
 */

import { useT } from '@postly/i18n';
import { useMutationQueue } from '@ultimat3/realtime';
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
  robots: 'noindex',
  meta: ({ t }) => ({
    title: t('site.offline.metaTitle'),
    description: t('site.offline.metaDescription'),
  }),
});

export function Page(): JSX.Element {
  const t = useT();
  const queue = useMutationQueue();

  return (
    <main class={styles.page}>
      <Stack gap="4">
        <h1>{t('site.offline.heading')}</h1>
        <p>{t('site.offline.body')}</p>

        <p class={styles.queue}>
          <Show when={queue.pending > 0} fallback={<span>{t('site.offline.queuedNone')}</span>}>
            <span>{t('site.offline.queued', { count: queue.pending })}</span>
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
