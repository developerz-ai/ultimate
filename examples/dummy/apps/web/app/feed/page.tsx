/**
 * The org feed. `stream` because an authed page needs both halves: the shell in the first flush,
 * the rows when the query resolves. Solid patches the streamed HTML in place, so the shell costs
 * no hydration and each `<Suspense>` island wakes on its own schedule.
 *
 * `useLive` returns a signal backed by the persisted local store, which is why this page is
 * readable in a tunnel and why a like taken offline is still here when the tunnel ends.
 */

import { useT } from '@postly/i18n';
import { PostCard } from '@postly/ui';
import { useActor } from '@ultimat3/core';
import { useConnection, useLive } from '@ultimat3/realtime';
import { defineRoute } from '@ultimat3/render';
import { Skeleton, Stack } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show, Suspense } from 'solid-js';
import { postHref, toCardPost } from '../../shared/entities';
import { Layout } from '../layout';
import { liveFeed } from '../posts/live';
import { LikeButton } from '../posts/ui/like-button';
import { useViewer } from '../viewer-context';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'stream',
  /**
   * Network-first for the document, cache-first for the content-hashed chunks. The feed's *rows*
   * are not cached by the service worker at all — they come from the persisted live query.
   */
  offline: 'runtime',
  hydrate: 'idle',
  budget: { js: '60kb', lcp: 2000 },
  meta: ({ t }) => ({ title: t('app.feed.metaTitle'), robots: 'noindex' }),
});

export function Page(): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();
  const connection = useConnection();
  const feed = useLive(liveFeed, () => ({ orgId: actor.orgId }));

  return (
    <Layout>
      <header class={styles.header}>
        <h1>{t('app.feed.heading', { org: actor.org.name })}</h1>
        <a class={styles.new} href="/posts/new">
          {t('app.feed.newPost')}
        </a>
      </header>

      <Show when={connection.offline}>
        <p class={styles.offline}>{t('app.feed.offlineNotice')}</p>
      </Show>

      {/* One streamed hole. The header above is already on screen while this resolves. */}
      <Suspense fallback={<Skeleton rows={4} label={t('app.feed.loading')} />}>
        <Show when={feed().length > 0} fallback={<p class={styles.empty}>{t('app.feed.empty')}</p>}>
          <Stack gap="4" as="ul" class={styles.list}>
            <For each={feed()}>
              {(post) => (
                <li>
                  <PostCard
                    post={toCardPost(post)}
                    href={postHref(post)}
                    zone={viewer.zone}
                    actions={<LikeButton postId={post.id} likeCount={post.likeCount} />}
                  />
                </li>
              )}
            </For>
          </Stack>
        </Show>
      </Suspense>
    </Layout>
  );
}
