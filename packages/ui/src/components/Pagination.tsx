// Cursor-first pagination — the only shape a Postgres-backed list should use.
// Numbered mode exists for prerendered archives where the total is known.
// One mode per use: callbacks (`onCursor` / `onPage`) for an island, or `hrefFor` for a
// server-rendered list — anchors the browser follows, with no script on the page.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { Button } from './Button';
import { Link } from './Link';
import styles from './Pagination.module.scss';

type PageDirection = 'next' | 'prev';

interface PaginationBaseProps {
  /** Opaque cursor for the following page; absent disables "next". */
  nextCursor?: string | undefined;
  prevCursor?: string | undefined;
  /** Already-translated; falls back to the ui.* catalog keys. */
  labelPrevious?: string | undefined;
  labelNext?: string | undefined;
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
  hrefFor?: undefined;
}

/** Link mode: each cursor is a URL, so the pager works with scripting off. */
export interface PaginationLinkProps extends PaginationBaseProps {
  /**
   * Link mode: the URL of the page a cursor names. Renders `<a rel="next|prev">` and attaches no
   * handler, so it needs no island. Cursor paging only — never beside `onCursor`, `onPage`,
   * `page` or `totalPages`.
   */
  hrefFor: (cursor: string, direction: 'next' | 'prev') => string;
  onCursor?: undefined;
  page?: undefined;
  totalPages?: undefined;
  onPage?: undefined;
}

export type PaginationProps = PaginationCallbackProps | PaginationLinkProps;

export function Pagination(props: PaginationProps): JSX.Element {
  const ui = useUi();
  const label = (direction: PageDirection): string =>
    direction === 'prev'
      ? (props.labelPrevious ?? ui.t(UI_KEYS.previous))
      : (props.labelNext ?? ui.t(UI_KEYS.next));
  const cursor = (direction: PageDirection): string | undefined =>
    direction === 'prev' ? props.prevCursor : props.nextCursor;
  // A cursor present means cursor mode, exactly as `page`'s own doc says. The inverted form —
  // "cursor mode when a number is MISSING" — silently dropped the cursor and paged by number the
  // moment a caller passed both, which is the shape a list that knows its total naturally has.
  const cursorMode = (): boolean =>
    props.nextCursor !== undefined ||
    props.prevCursor !== undefined ||
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
   * control that still takes a tab stop, and dropping the side would move the other one between
   * the first page and the second.
   */
  const side = (direction: PageDirection): JSX.Element => {
    const to = cursor(direction);
    if (props.hrefFor !== undefined && to !== undefined) {
      return (
        <Link
          appearance="button"
          variant="secondary"
          size="sm"
          tone="neutral"
          rel={direction}
          href={props.hrefFor(to, direction)}
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
      >
        {label(direction)}
      </Button>
    );
  };

  return (
    <nav class={cx(styles['pagination'], props.class)} aria-label={ui.t(UI_KEYS.page)}>
      {side('prev')}

      {cursorMode() ? null : (
        <span class={styles['status']} aria-live="polite">
          {`${props.page ?? 1} / ${props.totalPages ?? 1}`}
        </span>
      )}

      {side('next')}
    </nav>
  );
}
