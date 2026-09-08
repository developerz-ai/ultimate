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
 * **The STORE is the half nothing in this repo had ever supplied.**
 * `packages/realtime/src/client-mutations.ts` applies the optimistic twin under
 * `if (store && local && !collapsed)` and no app anywhere passed a `LocalStore`, so tier 3's
 * "my own click feels instant" was a documented capability that had never executed — the count on
 * screen sat at the server's value until a reload, and a refused write had nothing to take back.
 * `MemoryLocalStore` + `RebaseLog` below are the two objects that turn it on: the store journals
 * the twin's write under the mutation's idempotency key, the log holds the sequence a rollback
 * replays around. Both, or neither: `rollbackFailed` (`client-frames.ts`) returns early without
 * the pair, so a store with no log is an optimistic write that can never come off the screen.
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

import type { LocalStore, MutatorLike } from '@ultimat3/realtime';
import {
  LiveClient,
  MemoryLocalStore,
  MemoryQueueStore,
  OfflineQueue,
  RebaseLog,
  setLiveClient,
  useConnection,
  useMutation,
} from '@ultimat3/realtime';
import type { JSX } from 'solid-js';
import { createSignal, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { signal, socketFor } from '../../../shared/live-socket';
import { LIKE_POST } from '../like-mutation';
import styles from '../ui/like-button.module.scss';

/** Already translated, on the server: an island's props cross as JSON, so `t()` cannot travel. */
export interface LikeLabels {
  readonly like: string;
  /** `t('app.post.likes', { count })` — pluralised where the catalog is, never in the browser. */
  readonly count: string;
  /**
   * The same key at `count + 1`: what the count reads the instant this member's own like is
   * applied, before any server has answered.
   *
   * TWO strings and not a template, because a catalog cannot cross the wire and a browser that
   * substituted a number into one would be a second translator with no plural rules. Two is also
   * exactly how many the twin can produce: `likePostLocally` moves this row by one, once, and
   * never back. What it does NOT cover is a `rebase` frame landing a count neither string was
   * translated for — a concurrent like by somebody else. This island holds no live subscription
   * over `posts`, so that frame is the only other writer, and phrasing its number needs the count
   * to arrive as a live row rather than as a prop.
   */
  readonly countWithMine: string;
  readonly queued: string;
}

export interface LikeIslandProps {
  readonly postId: string;
  /** `postLike` decides on the org, so it rides in the mutator's input and not on the session. */
  readonly orgId: string;
  /** The server's count, as a NUMBER: it seeds the local row the optimistic twin then updates. */
  readonly likeCount: number;
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

interface LikeViewProps extends LikeIslandProps {
  /**
   * The client's own store. Deliberately not one of the island's props: those cross the seam as
   * JSON and this is an object with methods. It is here so the count can read the row the twin
   * writes, which is the only place an optimistic value exists.
   */
  readonly rows: LocalStore;
}

function Like(props: LikeViewProps): JSX.Element {
  const like = useMutation(MUTATOR);
  const connection = useConnection();

  // The row, mirrored into a signal. `IdentityMap` notifies once per batch — one twin, one render
  // — and every write produces a NEW row object, so a reference compare is enough to re-render.
  // Subscribed here rather than in `mount` so the listener dies with the component.
  const read = (): boolean => props.rows.tx.posts?.get(props.postId)?.['likedByMe'] === true;
  const [likedByMe, setLikedByMe] = createSignal(read());
  onCleanup(
    props.rows.identity.subscribe(() => {
      setLikedByMe(read());
    }),
  );

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
        The optimistic count. `likedByMe` is the twin's own flag rather than an increment computed
        here: a second arithmetic path for one intent is exactly what `local` exists to prevent,
        and a rollback then has nothing to undo it by. Refused, the server's `ack` carries an error,
        `rollbackFailed` undoes the journal under that key, this signal falls back to `false` and
        the string returns to the count the server rendered.
      */}
      <span class={styles.count} data-role="count">
        {likedByMe() ? props.labels.countWithMine : props.labels.count}
      </span>

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
 * `MemoryQueueStore` and `MemoryLocalStore` are the two stores this app has. Both survive a lost
 * socket, which is what the badge and the optimistic count are about, and neither survives a
 * reload — the OPFS tier that would is the same unshipped one `live.ts` records for `persist: true`
 * and `createOpfsLocalStore` refuses by name.
 *
 * The store is seeded with the ONE row this control is about, from the count the server already
 * rendered: `LocalTable.update` is a no-op for a row the table does not hold, so an unseeded store
 * is a twin that silently writes nothing — the same shape as having no store at all.
 *
 * `connect()` before `setLiveClient`, and both before the first render: a hook resolving the
 * client mid-render would mutate against a socket nothing has asked to open. The shell goes last
 * and it is load-bearing — Solid's `render` APPENDS when the container already has children.
 */
export async function mount(el: HTMLElement, props: LikeIslandProps): Promise<void> {
  const rows = new MemoryLocalStore({
    posts: [{ id: props.postId, likeCount: props.likeCount, likedByMe: false }],
  });
  const client = new LiveClient({
    signal,
    connect: () => socketFor(props.syncUrl),
    buildId: props.buildId,
    actorId: props.actorId,
    queue: await OfflineQueue.open(new MemoryQueueStore()),
    store: rows,
    log: new RebaseLog(),
  });
  client.connect();
  setLiveClient(client);
  el.textContent = '';
  render(() => <Like {...props} rows={rows} />, el);
}
