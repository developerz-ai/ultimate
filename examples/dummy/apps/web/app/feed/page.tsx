/**
 * The org feed. `stream` — the `app/` default — but not because of the rows: the rows arrive over
 * `useLive`'s socket subscription, not a resolving promise, so there is no hole for them to fill
 * and the loading gate below is still the live query's own `state()`, a plain reactive read. The
 * one genuine hole is the activity badge in the header: `queries.feedActivity` is its own read,
 * with its own cache tag, and the shell (heading, "new post" link, the feed's own loading gate)
 * has no reason to wait on it.
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
import { Suspense } from '../../shared/suspense';
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
  meta: ({ t }) => ({ title: t('app.feed.metaTitle'), robots: { index: false } }),
});

/**
 * The one async component on this page — its own read via the typed client, exactly like a
 * route's `load()` already does for `postById`, so a slow count never holds up the shell above.
 * Today's renderer resolves it before the first flush anyway (see `shared/suspense.ts`); this is
 * the shape that stops costing anything the day the hole actually streams.
 *
 * Cast at the bottom, not typed `async` directly: `render-html.ts`'s `unwrap` already awaits
 * whatever a component returns, so an async component works at runtime, but solid-js's `JSX`
 * namespace has no signature for one — a plain function returning `JSX.Element` is the only shape
 * it accepts as a component. The mismatch is type-only.
 */
async function activityBadge(props: { readonly orgId: string }): Promise<JSX.Element> {
  const t = useT();
  const [activity] = await queries.feedActivity({ orgId: props.orgId });
  const count = activity?.publishedCount ?? 0;
  return (
    <Text tone="muted" class={styles.activity}>
      {t('app.feed.activity', { count })}
    </Text>
  );
}

const ActivityBadge = activityBadge as unknown as (props: {
  readonly orgId: string;
}) => JSX.Element;

export function Page(): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();
  const connection = useConnection();
  const feed = useLiveFeed(() => ({ orgId: actor.orgId }));

  return (
    <Layout>
      <header class={styles.header}>
        <h1>{t('app.feed.heading', { org: actor.org.name })}</h1>
        <Suspense fallback={<Skeleton rows={1} label={t('app.feed.loading')} />}>
          <ActivityBadge orgId={actor.orgId} />
        </Suspense>
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
