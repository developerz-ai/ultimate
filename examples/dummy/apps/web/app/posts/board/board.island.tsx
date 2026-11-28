/**
 * The posts board, in the browser: `Board` from `@ultimat3/ui` over the org's posts by status. A
 * card moves by pointer, touch or keyboard, and a drop is a REQUEST: the card moves at once, then
 * `movePostStatus` — the same mutator the no-script form posts to — decides. A refusal (another
 * editor moved it first, or the member may not schedule this post) puts the card back, and `Board`
 * says so through the page's live region.
 *
 * `preview` exists for `board.island.states.ts` only: a states file cannot make a request.
 */

import type { CatalogSubset } from '@ultimat3/i18n/subset';
import { subsetTranslator } from '@ultimat3/i18n/subset';
import { mountOver } from '@ultimat3/render/client';
import { Board, type SortMove, setSolidRuntime, UiProvider } from '@ultimat3/ui';
import { layout, Presence } from '@ultimat3/ui/motion';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  onMount,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import { browserClient } from '../../../shared/browser-client';
import { MOVE_FIELDS, postCard } from './board-card';
import {
  type BoardLabels,
  type BoardPost,
  boardColumns,
  canMovePost,
  isSchedulable,
} from './board-columns';

export interface BoardIslandProps {
  readonly locale: string;
  readonly zone: string;
  readonly posts: readonly BoardPost[];
  readonly labels: BoardLabels;
  /** `movePostStatus`'s route: where each card's no-script form posts. */
  readonly action: string;
  /** The design system's `ui.*` strings, resolved on the server: a `t` cannot travel. */
  readonly ui: CatalogSubset;
}

export function PostBoard(props: BoardIslandProps): JSX.Element {
  const [posts, setPosts] = createSignal<readonly BoardPost[]>(props.posts);
  let surface: HTMLDivElement | undefined;
  // The server's board is already on screen: only a card that arrives AFTER the first paint — one
  // moved into another column — enters with a fade, so loading the page never flickers.
  let painted = false;
  onMount(() => {
    painted = true;
  });

  /**
   * One move, animated: every card is measured, the status changes, and each card that landed
   * elsewhere (the rest slide into the gap) plays from where it was. A card the change unmounted
   * has no box after it, which `layout` reads as a move to nowhere and animates harmlessly.
   */
  const settle = (change: () => void): void => {
    const cards = surface === undefined ? [] : [...surface.querySelectorAll('[data-presence]')];
    layout(cards, change, { duration: 'fast', easing: 'snappy' });
  };

  const onMove = async (move: SortMove): Promise<void> => {
    const from = move.fromGroup;
    const to = move.toGroup;
    // A reorder inside one column asks nothing: a status has no order to keep.
    if (from === to || !isSchedulable(from) || !isSchedulable(to)) return;
    const before = posts();
    settle(() =>
      setPosts(before.map((post) => (post.id === move.id ? { ...post, status: to } : post))),
    );
    try {
      await browserClient.movePostStatus({ id: move.id, from, to });
    } catch (error) {
      settle(() => setPosts(before));
      throw error;
    }
  };

  return (
    <div ref={surface}>
      <Board
        groups={boardColumns(posts(), props.labels.columns)}
        itemKey={(post: BoardPost) => post.id}
        renderItem={(post: BoardPost) => (
          <Presence when={post} appear={painted} duration="fast" easing="snappy">
            {postCard}
          </Presence>
        )}
        label={props.labels.board}
        onMove={onMove}
        canDrop={canMovePost}
        action={props.action}
        fields={MOVE_FIELDS}
      />
    </div>
  );
}

/**
 * The one export the hydration runtime calls. `mountOver` clears the server's shell (Solid's
 * `render` APPENDS) and puts it back if the render throws.
 */
export function mount(el: HTMLElement, props: BoardIslandProps): () => void {
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
          <PostBoard {...props} />
        </UiProvider>
      ),
      root,
    ),
  );
}
