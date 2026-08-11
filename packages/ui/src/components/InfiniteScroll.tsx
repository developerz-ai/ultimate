// An endless list that degrades to pagination: the foot is always a real `rel="next"` link, so
// the next page is one navigation away with scripting off. With script, a sentinel below the
// list asks for that page before the reader reaches it, and the link's click is intercepted.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import styles from './InfiniteScroll.module.scss';
import { loadMoreState } from './infinite-scroll-view';
import { Spinner } from './Spinner';

/** One viewport-ish of runway, so the next page is usually there before the current one ends. */
const ROOT_MARGIN = '400px';

export interface InfiniteScrollProps {
  /** The items rendered so far. This component owns the foot, never the list. */
  children: JSX.Element;
  /** Another page exists. */
  hasMore: boolean;
  /** The next page's URL. Required whenever `hasMore` — it is the no-JS path. */
  nextHref?: string | undefined;
  /** A page is in flight; the control stops inviting a second request. */
  loading?: boolean | undefined;
  /** The enhancement: called when the sentinel appears, and in place of following the link. */
  onLoadMore?: (() => void) | undefined;
  /** How far below the fold loading starts. A CSS length, as IntersectionObserver takes it. */
  rootMargin?: string | undefined;
  class?: string | undefined;
}

export function InfiniteScroll(props: InfiniteScrollProps): JSX.Element {
  const ui = useUi();
  const rt = solid();
  let sentinel: HTMLSpanElement | undefined;

  rt.createEffect(() => {
    const onLoadMore = props.onLoadMore;
    if (onLoadMore === undefined || sentinel === undefined) return;
    // No observer means no enhancement — the link below is already the working control.
    if (!props.hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (props.loading !== true && entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: props.rootMargin ?? ROOT_MARGIN },
    );
    observer.observe(sentinel);
    rt.onCleanup(() => observer.disconnect());
  });

  const onClick = (event: MouseEvent): void => {
    if (props.onLoadMore === undefined) return;
    event.preventDefault();
    props.onLoadMore();
  };

  const state = (): ReturnType<typeof loadMoreState> =>
    loadMoreState({
      hasMore: props.hasMore,
      loading: props.loading,
      nextHref: props.nextHref,
    });

  return (
    <div class={cx(styles['scroller'], props.class)} aria-busy={ariaBool(props.loading)}>
      {props.children}
      <div class={styles['foot']}>
        {state() === 'loading' ? <Spinner size="sm" /> : null}
        {state() === 'more' ? (
          <a class={styles['more']} href={props.nextHref} rel="next" onClick={onClick}>
            {ui.t(UI_KEYS.loadMore)}
          </a>
        ) : null}
        {state() === 'end' ? (
          <p class={styles['end']} role="status">
            {ui.t(UI_KEYS.endOfList)}
          </p>
        ) : null}
        <span
          aria-hidden="true"
          class={styles['sentinel']}
          ref={(el: HTMLSpanElement) => {
            sentinel = el;
          }}
        />
      </div>
    </div>
  );
}
