/**
 * The feed, in the browser: the one module of `/feed` a browser downloads, and the only place a
 * `LiveClient` is registered.
 *
 * The page server-renders the loading shell inside this island's wrapper, so the screen paints
 * before a byte of this arrives; `mount` opens the socket, subscribes, and replaces the shell with
 * whatever the subscription answers. That order is the whole of issue #271: a page that read the
 * live query in its own body had nowhere to put the rows, because no module of it ever ran here.
 *
 * Plain markup, deliberately. `@postly/ui`'s `PostCard` and `@ultimat3/ui`'s controls each weigh
 * more than this route's entire 60 kB budget once the live client is in the chunk, and an island
 * over budget is a page that boots slower than the server render it replaces. The server keeps the
 * rich rendering it already does elsewhere; this is the part only a browser can do.
 */

import type { ClientSocket, SignalFactory } from '@ultimat3/realtime';
import { LiveClient, setLiveClient, useConnection, useLive } from '@ultimat3/realtime';
import type { JSX } from 'solid-js';
import { createSignal, For, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { postHref } from '../../shared/entities';
import { type FeedRow, LIVE_FEED } from './live';

/** Already translated, on the server: an island's props cross as JSON, so `t()` cannot travel. */
export interface FeedLabels {
  readonly loading: string;
  readonly empty: string;
  readonly offline: string;
}

export interface FeedIslandProps {
  /** `ws://host:port` of the sync node, resolved by `sync-url.ts` on the server. */
  readonly syncUrl: string;
  /** This build, so the node can tell a stale tab to reload rather than serving it a patch. */
  readonly buildId: string;
  /** Who is subscribing. The node re-authorizes anyway; this is what the client announces. */
  readonly actorId: string;
  readonly orgId: string;
  readonly labels: FeedLabels;
}

/**
 * `WebSocket` as the framework's `ClientSocket`. Four handlers and a send — the reconnect, the
 * backoff and the heartbeat all stay in `LiveClient`, which is why this is the whole adapter.
 */
const socketFor = (url: string): ClientSocket => {
  const socket = new WebSocket(url);
  return {
    send: (data: string): void => {
      socket.send(data);
    },
    close: (code?: number, reason?: string): void => {
      socket.close(code, reason);
    },
    onOpen: (handler: () => void): void => {
      socket.onopen = (): void => {
        handler();
      };
    },
    onMessage: (handler: (data: string) => void): void => {
      socket.onmessage = (event: MessageEvent): void => {
        handler(String(event.data));
      };
    },
    onClose: (handler: (code: number) => void): void => {
      socket.onclose = (event: CloseEvent): void => {
        handler(event.code);
      };
    },
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
  };
};

/**
 * Solid's `createSignal`, narrowed to the two-function shape realtime declares. Wrapped rather
 * than passed: Solid's setter also accepts an updater function, so a `T` that IS a function would
 * be called instead of stored.
 */
const signal: SignalFactory = <T,>(initial: T): [() => T, (next: T) => void] => {
  const [get, set] = createSignal<T>(initial);
  return [
    get,
    (next: T): void => {
      set(() => next);
    },
  ];
};

function Feed(props: FeedIslandProps): JSX.Element {
  const connection = useConnection();
  const feed = useLive<FeedRow>({ name: LIVE_FEED }, { orgId: props.orgId });

  return (
    <>
      {/* Only beside rows there ARE. A socket that has not finished connecting is `offline` too,
          and a notice about the copy on this device is a lie when nothing is on screen yet. */}
      <Show when={connection.offline && feed().length > 0}>
        <p data-role="offline">{props.labels.offline}</p>
      </Show>
      <Show
        when={feed().length > 0}
        fallback={
          // `empty` is only honest once the node has ANSWERED: `state()` is `offline` before the
          // socket opens and `loading` while the subscription is in flight, and telling a member
          // their feed is empty in either is a claim nothing has made.
          <Show
            when={feed.state() === 'live'}
            fallback={<p data-role="loading">{props.labels.loading}</p>}
          >
            <p data-role="empty">{props.labels.empty}</p>
          </Show>
        }
      >
        <ul data-role="posts">
          <For each={feed()}>
            {(post) => (
              <li>
                <a href={postHref(post)}>{post.title}</a>
                <p>{post.excerpt}</p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}

/**
 * The one export the hydration runtime calls. `connect()` before `setLiveClient`, and both before
 * the first render: a hook resolving the client mid-render would subscribe against a socket that
 * has not been asked to open yet.
 */
export function mount(el: HTMLElement, props: FeedIslandProps): void {
  const client = new LiveClient({
    signal,
    connect: () => socketFor(props.syncUrl),
    buildId: props.buildId,
    actorId: props.actorId,
  });
  client.connect();
  setLiveClient(client);
  // Solid's `render` APPENDS when the container already has children, so the server's loading
  // shell would sit above the live list — `settings.island.tsx`'s rule, verbatim.
  el.textContent = '';
  render(() => <Feed {...props} />, el);
}
