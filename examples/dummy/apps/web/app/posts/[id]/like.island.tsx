/**
 * The like control, in the browser: the one module of `/posts/{id}` a browser downloads, and the
 * only place this route registers a `LiveClient`.
 *
 * Issue #271's shape a second time. The page rendered `<LikeButton>` — `useMutation()` and
 * `useConnection()` — in its own body while declaring no `island()`, so no module of the route
 * ever ran in a browser: the button was inert and the queued badge could not appear.
 * `X_LIVE_ROUTE_NO_ISLAND` is the build error that says so.
 *
 * **The queue is the half a mounting test passes over.** `useMutation().pending` reads
 * `client.queue` and answers `0` for every mutator when there is none
 * (`packages/realtime/src/hooks.ts`), so an island that boots, connects and sends is still an
 * island whose offline badge can never render. `/feed`'s client carries no queue because it only
 * READS; this one writes, so it opens one.
 *
 * Named for the control rather than for its directory, which is where the two precedents' rule
 * (`feed/feed.island.tsx`, `settings/settings.island.tsx`) stops answering: this directory is
 * `[id]`, a route PARAMETER, so `[id].island.tsx` would carry glob metacharacters and reduce to
 * the module id `id` — a name for nothing.
 *
 * Plain markup and no `@ultimat3/ui`, the rule `feed.island.tsx` measured: one control from the
 * design system weighs more than this whole route's budget once `LiveClient` is in the chunk. The
 * classes come from the same `.module.scss` the server shell renders, so the two agree by
 * construction — the scope hash is over the file's basename plus its source, never its path.
 */

import type { MutatorLike } from '@ultimat3/realtime';
import {
  LiveClient,
  MemoryQueueStore,
  OfflineQueue,
  setLiveClient,
  useConnection,
  useMutation,
} from '@ultimat3/realtime';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { render } from 'solid-js/web';
import { signal, socketFor } from '../../../shared/live-socket';
import { LIKE_POST } from '../like-mutation';
import styles from '../ui/like-button.module.scss';

/** Already translated, on the server: an island's props cross as JSON, so `t()` cannot travel. */
export interface LikeLabels {
  readonly like: string;
  /** `t('app.post.likes', { count })` — pluralised where the catalog is, never in the browser. */
  readonly count: string;
  readonly queued: string;
}

export interface LikeIslandProps {
  readonly postId: string;
  /** `postLike` decides on the org, so it rides in the mutator's input and not on the session. */
  readonly orgId: string;
  /** `ws://host:port` of the sync node, resolved by `shared/sync-url.ts` on the server. */
  readonly syncUrl: string;
  /** This build, so the node can tell a stale tab to reload rather than serving it a patch. */
  readonly buildId: string;
  /** Who is mutating. The node re-authorizes anyway; this is what the client announces. */
  readonly actorId: string;
  readonly labels: LikeLabels;
}

/** Hoisted: `useMutation` binds a fresh `MutatorRef` per call, and one intent has one name. */
const MUTATOR: MutatorLike = LIKE_POST;

function Like(props: LikeIslandProps): JSX.Element {
  const like = useMutation(MUTATOR);
  const connection = useConnection();

  return (
    <div class={styles.row}>
      <button
        class={styles.button}
        type="button"
        onClick={() => void like({ postId: props.postId, orgId: props.orgId })}
      >
        {props.labels.like}
      </button>

      {/*
        The server's count, unmoved. The optimistic +1 is `mutator.ts`'s `local` twin, which is
        replayed against the durable client store this app does not configure yet — inventing a
        second count here would be a second optimistic path for one intent.
      */}
      <span class={styles.count}>{props.labels.count}</span>

      {/* The queue is durable, so this is information, not an error. */}
      <Show when={connection.offline && like.pending > 0}>
        <span class={styles.queued} data-role="queued">
          {props.labels.queued}
        </span>
      </Show>
    </div>
  );
}

/**
 * The one export the hydration runtime calls — `import(entry).then((m) => m.mount(el, props))`,
 * which awaits what `mount` returns and only then marks the element mounted. So opening the queue
 * here is not a race: `OfflineQueue.open` rehydrates from its store before a click can be handed a
 * client that has none.
 *
 * `MemoryQueueStore` is the store this app has. It survives a lost socket, which is what the badge
 * is about, and not a reload — the OPFS store that would is the same unshipped tier `live.ts`
 * records for `persist: true`.
 *
 * `connect()` before `setLiveClient`, and both before the first render: a hook resolving the
 * client mid-render would mutate against a socket nothing has asked to open. The shell goes last
 * and it is load-bearing — Solid's `render` APPENDS when the container already has children.
 */
export async function mount(el: HTMLElement, props: LikeIslandProps): Promise<void> {
  const client = new LiveClient({
    signal,
    connect: () => socketFor(props.syncUrl),
    buildId: props.buildId,
    actorId: props.actorId,
    queue: await OfflineQueue.open(new MemoryQueueStore()),
  });
  client.connect();
  setLiveClient(client);
  el.textContent = '';
  render(() => <Like {...props} />, el);
}
