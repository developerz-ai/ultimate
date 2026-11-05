// Cursor-first pagination — the only shape a Postgres-backed list should use; numbered mode is for
// prerendered archives with a known total. One mode per use: callbacks for an island, or `hrefFor`
// anchors with no script. Keyset paging has no way back, so Previous is drawn only when there is
// one, and `firstHref`/`onFirst` restart the list.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { Button } from './Button';
import { Link } from './Link';
import styles from './Pagination.module.scss';

type PageDirection = 'next' | 'prev';

interface PaginationBaseProps {
  /**
   * Opaque cursor for the following page; `null` or absent disables "next" — one state, so a
   * framework `Page`'s `nextCursor` is handed straight through.
   */
  nextCursor?: string | null | undefined;
  /** The cursor back. A keyset `Page` has none, and with none no Previous is drawn at all. */
  prevCursor?: string | null | undefined;
  /** Already-translated; falls back to the ui.* catalog keys. */
  labelPrevious?: string | undefined;
  labelNext?: string | undefined;
  labelFirst?: string | undefined;
  class?: string | undefined;
}

/** Callback mode: the page is an island and pages itself. */
export interface PaginationCallbackProps extends PaginationBaseProps {
  /** Callback mode. Never beside `hrefFor` — the type refuses the pair. */
  onCursor?: ((cursor: string, direction: 'next' | 'prev') => void) | undefined;
  /** Numbered mode: 1-based page and total. Ignored when cursors are present. */
  page?: number | undefined;
  totalPages?: number | undefined;
  onPage?: ((page: number) => void) | undefined;
  /** Back to the start: a "First" button. Callback mode's `firstHref`. */
  onFirst?: (() => void) | undefined;
  hrefFor?: undefined;
  firstHref?: undefined;
}

/** Link mode: each cursor is a URL, so the pager works with scripting off. */
export interface PaginationLinkProps extends PaginationBaseProps {
  /**
   * Link mode: the URL of the page a cursor names. Renders `<a rel="next|prev">` and attaches no
   * handler, so it needs no island. Cursor paging only — never beside `onCursor`, `onPage`,
   * `page` or `totalPages`.
   */
  hrefFor: (cursor: string, direction: 'next' | 'prev') => string;
  /** The URL of the first page: a "First" anchor. Absent — already there — draws none. */
  firstHref?: string | undefined;
  onCursor?: undefined;
  page?: undefined;
  totalPages?: undefined;
  onPage?: undefined;
  onFirst?: undefined;
}

export type PaginationProps = PaginationCallbackProps | PaginationLinkProps;

export function Pagination(props: PaginationProps): JSX.Element {
  const ui = useUi();
  const label = (direction: PageDirection): string =>
    direction === 'prev'
      ? (props.labelPrevious ?? ui.t(UI_KEYS.previous))
      : (props.labelNext ?? ui.t(UI_KEYS.next));
  // `null` and `undefined` are one state: a `Page` says "no next page" with `null`.
  const cursor = (direction: PageDirection): string | undefined =>
    (direction === 'prev' ? props.prevCursor : props.nextCursor) ?? undefined;
  // A cursor present means cursor mode, exactly as `page`'s own doc says. The inverted form —
  // "cursor mode when a number is MISSING" — silently dropped the cursor and paged by number the
  // moment a caller passed both, which is the shape a list that knows its total naturally has.
  const cursorMode = (): boolean =>
    cursor('next') !== undefined ||
    cursor('prev') !== undefined ||
    props.page === undefined ||
    props.totalPages === undefined;

  const exhausted = (direction: PageDirection): boolean => {
    if (cursorMode()) return cursor(direction) === undefined;
    return direction === 'prev'
      ? (props.page ?? 1) <= 1
      : (props.page ?? 1) >= (props.totalPages ?? 1);
  };

  const go = (direction: PageDirection): void => {
    const to = cursor(direction);
    if (cursorMode()) {
      if (to !== undefined) props.onCursor?.(to, direction);
    } else if (direction === 'prev') {
      props.onPage?.(Math.max(1, (props.page ?? 1) - 1));
    } else {
      props.onPage?.(Math.min(props.totalPages ?? 1, (props.page ?? 1) + 1));
    }
  };

  /**
   * One side of the pager. In link mode a side WITH a cursor is an anchor and a side without one
   * is the same disabled button callback mode shows: an anchor with nowhere to go is a dead
   * control that still takes a tab stop. Next stays put whether or not Previous is drawn —
   * `.next` pins it to the trailing edge, so it never moves between the first page and the second.
   */
  const side = (direction: PageDirection): JSX.Element => {
    const to = cursor(direction);
    const place = direction === 'next' ? styles['next'] : undefined;
    if (props.hrefFor !== undefined && to !== undefined) {
      return (
        <Link
          appearance="button"
          variant="secondary"
          size="sm"
          tone="neutral"
          rel={direction}
          href={props.hrefFor(to, direction)}
          class={place}
        >
          {label(direction)}
        </Link>
      );
    }
    return (
      <Button
        variant="secondary"
        size="sm"
        tone="neutral"
        disabled={exhausted(direction)}
        onClick={props.hrefFor === undefined ? () => go(direction) : undefined}
        class={place}
      >
        {label(direction)}
      </Button>
    );
  };

  /** A keyset page has no previous cursor: a Previous for it would be disabled forever. */
  const hasPrevious = (): boolean => !cursorMode() || cursor('prev') !== undefined;

  /** Back to the start — the one way back a keyset list has. Drawn only when it is given. */
  const first = (): JSX.Element => {
    const text = props.labelFirst ?? ui.t(UI_KEYS.first);
    if (props.firstHref !== undefined) {
      return (
        <Link
          appearance="button"
          variant="secondary"
          size="sm"
          tone="neutral"
          href={props.firstHref}
        >
          {text}
        </Link>
      );
    }
    const onFirst = props.onFirst;
    if (onFirst === undefined) return null;
    return (
      <Button variant="secondary" size="sm" tone="neutral" onClick={() => onFirst()}>
        {text}
      </Button>
    );
  };

  return (
    <nav class={cx(styles['pagination'], props.class)} aria-label={ui.t(UI_KEYS.page)}>
      {first()}
      {hasPrevious() ? side('prev') : null}

      {cursorMode() ? null : (
        <span class={styles['status']} aria-live="polite">
          {`${props.page ?? 1} / ${props.totalPages ?? 1}`}
        </span>
      )}

      {side('next')}
    </nav>
  );
}
