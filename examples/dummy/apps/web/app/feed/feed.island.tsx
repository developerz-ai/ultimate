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
 *
 * A pull at the top of the list re-reads it (`PullToRefresh`, touch only), and the toolbar's button
 * does the same for every other pointer and the keyboard. `feed-commands.tsx` is the page's
 * keyboard layer: `⌘K` and `?`.
 */

import type { CatalogSubset } from '@ultimat3/i18n/subset';
import { subsetTranslator } from '@ultimat3/i18n/subset';
import { useConnection, useMutation, useOutbox, useQuery } from '@ultimat3/realtime';
import { mountOver } from '@ultimat3/render/client';
import { formatDate } from '@ultimat3/time';
import {
  AsyncRegion,
  Button,
  DateTime,
  type DateTimeFormatter,
  EmptyState,
  PullToRefresh,
  setSolidRuntime,
  Toolbar,
  UiProvider,
  VirtualList,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  Show,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { postHref } from '../../shared/entities';
import { type PluralForms, pluralText } from '../../shared/plural-text';
import { LIKE_POST } from '../posts/like-mutation';
import { type CommandLabels, type Destination, FeedCommands } from './feed-commands';
import { type FeedRow, LIVE_FEED } from './live';
import styles from './page.module.scss';

/** A row's height before it is measured: a title, a date, a two-line excerpt and the like row. */
const ROW_ESTIMATE_PX = 140;

/** The day alone, `dateStyle: 'long'`: a feed row says when, the post page says at what time. */
const dayOnly: DateTimeFormatter = (at, options) =>
  formatDate(at, { locale: options.locale, zone: options.zone, style: 'long' });

/** Already translated, on the server: an island's props cross as JSON, so `t()` cannot travel. */
export interface FeedLabels {
  readonly empty: string;
  /** The list's accessible name. */
  readonly list: string;
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
  /** The toolbar's re-read: the way to refresh for every pointer that cannot pull. */
  readonly refresh?: string;
}

export interface FeedIslandProps {
  readonly orgId: string;
  readonly locale: string;
  /** The member's IANA zone — every date on the feed is formatted in it, never the device's. */
  readonly zone: string;
  readonly labels: FeedLabels;
  /** The design system's `ui.*` strings, resolved on the server (`uiCatalog(t)`): a `t` cannot travel. */
  readonly ui: CatalogSubset;
  /** The keyboard layer's strings and the app's destinations; absent, the page has none. */
  readonly commands?: {
    readonly labels: CommandLabels;
    readonly destinations: readonly Destination[];
  };
}

function Feed(props: FeedIslandProps): JSX.Element {
  const feed = useQuery<FeedRow>({ name: LIVE_FEED, live: true }, { orgId: props.orgId });
  const connection = useConnection();
  const like = useMutation(LIKE_POST);
  const outbox = useOutbox();
  /**
   * The pull's and the button's one re-read: `refetch` settles when the read has, so the busy state
   * lasts exactly as long. The feed is LIVE, so that is at once: its socket is its refresh.
   */
  const reread = (): Promise<void> => feed.refetch();
  const rows = (): readonly FeedRow[] => {
    const state = feed();
    return state.status === 'ready' || state.status === 'refreshing' ? state.data : [];
  };
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
      <Show when={outbox.size > 0}>
        <p data-role="queued">{props.labels.queued}</p>
      </Show>
      <Show when={props.commands}>
        {(commands) => (
          <FeedCommands
            labels={commands().labels}
            destinations={commands().destinations}
            posts={() => rows().map((post) => ({ title: post.title, href: postHref(post) }))}
          />
        )}
      </Show>
      <Show when={props.labels.refresh}>
        {(label) => (
          <Toolbar label={label()}>
            <Button variant="secondary" size="sm" onClick={() => void reread()}>
              {label()}
            </Button>
          </Toolbar>
        )}
      </Show>
      {/* A failed re-read is the region's own `failed` branch: nothing for the pull to add. */}
      <PullToRefresh onRefresh={reread} onError={() => undefined}>
        <AsyncRegion
          state={feed()}
          reserve={{ lines: 4 }}
          empty={() => <EmptyState title={props.labels.empty} />}
          ready={(rows) => (
            // A feed is long and live: only the rows on screen are mounted, and a post arriving
            // at the top while the reader is further down moves nothing they are reading.
            <div class={styles.posts} data-role="posts">
              <VirtualList
                items={rows}
                itemKey={(post: FeedRow) => post.id}
                label={props.labels.list}
                estimate={ROW_ESTIMATE_PX}
                renderItem={(post: FeedRow) => (
                  <article>
                    <a href={postHref(post)}>{post.title}</a>
                    <DateTime value={post.publishedAt ?? post.createdAt} format={dayOnly} />
                    <p>{post.excerpt}</p>
                    <button
                      type="button"
                      data-like-button={post.id}
                      onClick={() => {
                        // A refusal has already taken its overlay back; the count IS the answer.
                        void like({ postId: post.id, orgId: props.orgId }).catch(() => undefined);
                      }}
                    >
                      {props.labels.like}
                    </button>
                    <span data-role="likes" data-like-count={post.likeCount} data-post={post.id}>
                      {pluralText(props.labels.likes, post.likeCount)}
                    </span>
                  </article>
                )}
              />
            </div>
          )}
        />
      </PullToRefresh>
    </>
  );
}

/**
 * The one export the hydration runtime calls. `mountOver` clears the server's loading shell (Solid's
 * `render` APPENDS) and puts it back if the render throws — `settings.island.tsx`'s rule, verbatim.
 */
export function mount(el: HTMLElement, props: FeedIslandProps): () => void {
  // The design system's reactive seam, from THIS bundle's solid-js — named, never `import *`.
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  // Returned: the router calls it when it swaps this page out, so every effect this island
  // registered — a socket read, a page-wide hotkey — ends with the page that drew it.
  return mountOver(el, (root) =>
    render(
      () => (
        <UiProvider locale={props.locale} timeZone={props.zone} t={subsetTranslator(props.ui)}>
          <Feed {...props} />
        </UiProvider>
      ),
      root,
    ),
  );
}
