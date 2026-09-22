/**
 * The feed, in the browser: the one module of `/feed` a browser downloads.
 *
 * `useQuery(LIVE_FEED, { orgId })` — the ONE read hook. The query is declared `live`, so its rows
 * arrive and move over the page's one socket, and they are RECORDS: each row is the page store's
 * `posts:<id>`, so a like in the post page's island — or in another tab — re-renders this list
 * without a refetch. No socket, signal or client is built here: `x build` prepends the bootstrap
 * that installs the page's realtime, and the document names the sync node in its `<head>`.
 *
 * Rendered through `@ultimat3/ui`'s `AsyncRegion`, which owns the four states a live read has —
 * pending, failed, empty, ready — so this file writes none of them by hand.
 *
 * Each row carries its date, in the MEMBER's zone and locale, and a like control — what the feed
 * showed until #271 moved its rows into this island and left both behind. The like is
 * `useMutation(LIKE_POST)`, the same write `like.island.tsx` makes: the optimistic twin moves the
 * row's own record, so the count beside the button is the store's, and a like taken offline waits
 * in the page's outbox with the queued notice showing.
 */

import { useConnection, useMutation, useQuery } from '@ultimat3/realtime';
import { formatDate } from '@ultimat3/time';
import {
  AsyncRegion,
  DateTime,
  type DateTimeFormatter,
  EmptyState,
  setSolidRuntime,
  UiProvider,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { postHref } from '../../shared/entities';
import { type PluralForms, pluralText } from '../../shared/plural-text';
import { trackQueued } from '../../shared/queued-writes';
import { type UiStrings, uiTranslator } from '../../shared/ui-strings';
import { LIKE_POST } from '../posts/like-mutation';
import { type FeedRow, LIVE_FEED } from './live';

/** The day alone, `dateStyle: 'long'`: a feed row says when, the post page says at what time. */
const dayOnly: DateTimeFormatter = (at, options) =>
  formatDate(at, { locale: options.locale, zone: options.zone, style: 'long' });

/** Already translated, on the server: an island's props cross as JSON, so `t()` cannot travel. */
export interface FeedLabels {
  readonly empty: string;
  /** Beside rows there ARE, while the socket is down: they are this device's copy. */
  readonly offline: string;
  /** Every plural form of `app.post.likes`: a row's count moves after the page was rendered. */
  readonly likes: PluralForms;
  readonly like: string;
  /** While a like waits in the outbox with the network gone: information, not an error. */
  readonly queued: string;
  /**
   * The sync node's "a new build is live", read off the socket this island already holds. The
   * layout's banner hears the service worker; this is the socket's half, where no extra byte buys it.
   */
  readonly update: string;
  readonly reload: string;
}

export interface FeedIslandProps {
  readonly orgId: string;
  readonly locale: string;
  /** The member's IANA zone — every date on the feed is formatted in it, never the device's. */
  readonly zone: string;
  readonly labels: FeedLabels;
  /** The `ui.*` strings `AsyncRegion`'s failure and empty branches read (`shared/ui-strings.ts`). */
  readonly ui: UiStrings;
}

function Feed(props: FeedIslandProps): JSX.Element {
  const feed = useQuery<FeedRow>({ name: LIVE_FEED, live: true }, { orgId: props.orgId });
  const connection = useConnection();
  const like = useMutation(LIKE_POST);
  const queued = trackQueued();
  onCleanup(() => {
    feed.release();
    connection.release();
    like.release();
  });
  const shown = (): number => {
    const state = feed();
    return state.status === 'ready' || state.status === 'refreshing' ? state.data.length : 0;
  };

  return (
    <>
      {/* Only beside rows there ARE: a notice about the copy on this device is a lie over nothing. */}
      <Show when={connection.offline && shown() > 0}>
        <p data-role="offline">{props.labels.offline}</p>
      </Show>
      <Show when={connection.updateAvailable !== null}>
        <p role="status" data-role="update-available">
          {props.labels.update}{' '}
          <button type="button" onClick={() => location.reload()}>
            {props.labels.reload}
          </button>
        </p>
      </Show>
      <Show when={queued.count() > 0}>
        <p data-role="queued">{props.labels.queued}</p>
      </Show>
      <AsyncRegion
        state={feed()}
        reserve={{ lines: 4 }}
        empty={() => <EmptyState title={props.labels.empty} />}
        ready={(rows) => (
          <ul data-role="posts">
            <For each={rows}>
              {(post) => (
                <li>
                  <a href={postHref(post)}>{post.title}</a>
                  <DateTime value={post.publishedAt ?? post.createdAt} format={dayOnly} />
                  <p>{post.excerpt}</p>
                  <button
                    type="button"
                    data-like-button={post.id}
                    onClick={() => {
                      // A refusal has already taken its overlay back; the count IS the answer.
                      void queued.track(like({ postId: post.id, orgId: props.orgId }));
                    }}
                  >
                    {props.labels.like}
                  </button>
                  <span data-role="likes" data-like-count={post.likeCount} data-post={post.id}>
                    {pluralText(props.labels.likes, post.likeCount)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        )}
      />
    </>
  );
}

/**
 * The one export the hydration runtime calls. Solid's `render` APPENDS when the container already
 * has children, so the server's loading shell goes first — `settings.island.tsx`'s rule, verbatim.
 */
export function mount(el: HTMLElement, props: FeedIslandProps): void {
  // The design system's reactive seam, from THIS bundle's solid-js — named, never `import *`.
  setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup });
  el.textContent = '';
  render(
    () => (
      <UiProvider
        locale={props.locale}
        timeZone={props.zone}
        t={uiTranslator(props.ui, props.locale)}
      >
        <Feed {...props} />
      </UiProvider>
    ),
    el,
  );
}
