/**
 * The like control, in the browser: one of the two modules of `/posts/{id}` a browser downloads.
 *
 * It holds nothing of its own. The post is a RECORD in the page's one store, `posts:<id>`:
 * - `useQuery(POST_RECORD_READ)` seeds it — the post as its whole row, adopted from the answer;
 * - `useChannel(ORG_POSTS)` keeps it current — every committed `posts` row of the org lands there,
 *   so a like from another tab or another member moves this count with no refetch;
 * - `useMutation(LIKE_POST)` writes it — the optimistic twin into the store's overlay, the action
 *   over HTTP, the overlay taken back if the server refuses;
 * - `useRecord('posts', postId)` reads it — the same object `likes-badge.island.tsx` reads, which
 *   is the whole of "one record, many places".
 * No socket, queue, store or log is built here: `x build` prepends the bootstrap that installs the
 * page's realtime, and the document names the sync node in its `<head>`.
 *
 * Named for the control rather than for its directory: `[id]` is a route PARAMETER, so
 * `[id].island.tsx` would carry glob metacharacters and reduce to the module id `id`.
 *
 * Plain markup and no `@ultimat3/ui`: the classes come from the `.module.scss` the server shell
 * renders, so the two agree by construction.
 */

import { useChannel, useConnection, useMutation, useQuery, useRecord } from '@ultimat3/realtime';
import type { JSX } from 'solid-js';
import { onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { type PluralForms, pluralText } from '../../../shared/plural-text';
import { trackQueued } from '../../../shared/queued-writes';
import { ORG_POSTS, POST_RECORD_READ, type PostRecord } from '../channel-ref';
import { LIKE_POST } from '../like-mutation';
import styles from '../ui/like-button.module.scss';

/** Already translated, on the server: an island's props cross as JSON, so `t()` cannot travel. */
export interface LikeLabels {
  readonly like: string;
  /** Every plural form of `app.post.likes` — the count can be one no string was rendered for. */
  readonly likes: PluralForms;
  readonly queued: string;
  /**
   * The sync node's "a new build is live", read off the socket this island already holds. The
   * layout's banner hears the service worker; this is the socket's half, where no extra byte buys it.
   */
  readonly update: string;
  readonly reload: string;
}

export interface LikeIslandProps {
  readonly postId: string;
  /** `postLike` decides on the org, so it rides in the mutator's input and not on the session. */
  readonly orgId: string;
  /** The server's count: what shows until the record lands — never a second source after it. */
  readonly likeCount: number;
  readonly labels: LikeLabels;
}

function Like(props: LikeIslandProps): JSX.Element {
  const seed = useQuery<PostRecord>(
    { name: POST_RECORD_READ, entity: 'posts' },
    { orgId: props.orgId, postId: props.postId },
  );
  const channel = useChannel(ORG_POSTS, { orgId: props.orgId });
  const post = useRecord<PostRecord>('posts', props.postId);
  const like = useMutation(LIKE_POST);
  const queued = trackQueued();
  const connection = useConnection();
  onCleanup(() => {
    for (const held of [seed, channel, post, like, connection]) held.release();
  });

  const count = (): number => {
    const state = post();
    return state.status === 'ready' || state.status === 'refreshing'
      ? (state.data?.likeCount ?? props.likeCount)
      : props.likeCount;
  };

  return (
    // `data-channel` is the org channel's state — `live` once its first catch-up read has landed.
    // A test that counts requests waits on it: before then, the fresh seat's one re-read is still
    // owed, and would be counted against whatever the test did next.
    <div class={styles.row} data-channel={channel()}>
      <button
        class={styles.button}
        type="button"
        data-like-button={props.postId}
        onClick={() => {
          // A refusal has already taken its overlay back — the count on screen IS the answer, and
          // the page's `useMutationQueue().failed` counts it. Nothing is left to do with the error
          // here, and left unhandled it would be a rejection nobody awaits.
          void queued.track(like({ postId: props.postId, orgId: props.orgId }));
        }}
      >
        {props.labels.like}
      </button>

      {/* The record's count: the twin's optimistic +1, the server's answer, another tab's like —
          whichever moved the record last. Phrased by the catalog's own forms (`plural-text.ts`). */}
      <span
        class={styles.count}
        data-role="count"
        data-like-count={count()}
        data-post={props.postId}
      >
        {pluralText(props.labels.likes, count())}
      </span>

      {/* Queued in the page's outbox while the network is gone: information, not an error. */}
      <Show when={connection.updateAvailable !== null}>
        <span role="status" data-role="update-available">
          {props.labels.update}{' '}
          <button type="button" onClick={() => location.reload()}>
            {props.labels.reload}
          </button>
        </span>
      </Show>
      <Show when={queued.count() > 0}>
        <span class={styles.queued} data-role="queued">
          {props.labels.queued}
        </span>
      </Show>
    </div>
  );
}

/**
 * The one export the hydration runtime calls. The shell goes first and it is load-bearing —
 * Solid's `render` APPENDS when the container already has children.
 */
export function mount(el: HTMLElement, props: LikeIslandProps): void {
  el.textContent = '';
  render(() => <Like {...props} />, el);
}
