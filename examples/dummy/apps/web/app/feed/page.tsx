/**
 * The org feed. `stream` — the `app/` default — but not because of the rows: the rows arrive over
 * `useLive`'s socket subscription, not a resolving promise, so the loading gate below is the live
 * query's own `state()`, a plain reactive read.
 *
 * `useLive` returns a signal backed by the persisted local store, which is why this page is
 * readable in a tunnel and why a like taken offline is still here when the tunnel ends.
 */

import { useT } from '@postly/i18n';
import { PostCard } from '@postly/ui';
import { useConnection } from '@ultimat3/realtime';
import { defineRoute } from '@ultimat3/render';
import { Skeleton, Stack, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { For, Show } from 'solid-js';
import { useActor } from '../../shared/actor';
import { queries } from '../../shared/client';
import { postHref, toCardPost } from '../../shared/entities';
import { Layout } from '../layout';
import { LikeButton } from '../posts/ui/like-button';
import { useViewer } from '../viewer-context';
import { useLiveFeed } from './hooks';
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
  /**
   * The badge's count is a read, so it is resolved here — the same place `postById` is resolved
   * for `/posts/{id}`, and the only place this app fetches. It was an async component inside a
   * `<Suspense>` until 2026-08, which bought nothing and cost a second data-fetching path:
   * nothing splits a page into holes yet (`packages/cli/src/dev-render.ts`'s `stream` case), so
   * the shell waited for the count anyway and the fallback was never rendered. When holes land,
   * the boundary goes back here, around a component that still takes its rows as props.
   */
  load: () => queries.feedActivity({ orgId: useActor().orgId }),
  meta: ({ t }) => ({ title: t('app.feed.metaTitle'), robots: { index: false } }),
});

/** The rows the read answered: one synthetic row per org, or none before the first post. */
type FeedActivity = Awaited<ReturnType<typeof queries.feedActivity>>;

export function Page(props: { readonly data: FeedActivity }): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();
  const connection = useConnection();
  const feed = useLiveFeed(() => ({ orgId: actor.orgId }));

  return (
    <Layout>
      <header class={styles.header}>
        <h1>{t('app.feed.heading', { org: actor.org.name })}</h1>
        <Text tone="muted" class={styles.activity}>
          {t('app.feed.activity', { count: props.data[0]?.publishedCount ?? 0 })}
        </Text>
        <a class={styles.new} href="/posts/new">
          {t('app.feed.newPost')}
        </a>
      </header>

      <Show when={connection.offline}>
        <p class={styles.offline}>{t('app.feed.offlineNotice')}</p>
      </Show>

      {/*
        The live-query loading gate, not a streamed hole: `feed.state()` is a plain reactive read
        off the query handle, not a promise `<Suspense>` could wait on — the rows arrive over the
        socket, so `loading` is a fact the handle carries, not a hole the server fills in later.
      */}
      <Show
        when={feed.state() !== 'loading'}
        fallback={<Skeleton rows={4} label={t('app.feed.loading')} />}
      >
        <Show when={feed().length > 0} fallback={<p class={styles.empty}>{t('app.feed.empty')}</p>}>
          <Stack gap="4" as="ul" class={styles.list}>
            <For each={feed()}>
              {(post) => (
                <li>
                  <PostCard
                    post={toCardPost(post)}
                    href={postHref(post)}
                    zone={viewer.zone}
                    actions={
                      /* `postLike` decides on the org, so it travels in the mutator's input —
                         off the ROW, which is the org the like is actually against, and which
                         an offline queue replays hours later with no session to reach for. */
                      <LikeButton postId={post.id} orgId={post.orgId} likeCount={post.likeCount} />
                    }
                  />
                </li>
              )}
            </For>
          </Stack>
        </Show>
      </Show>
    </Layout>
  );
}
