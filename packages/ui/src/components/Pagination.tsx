// Cursor-first pagination — the only shape a Postgres-backed list should use.
// Numbered mode exists for prerendered archives where the total is known.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { Button } from './Button';
import styles from './Pagination.module.scss';

export interface PaginationProps {
  /** Opaque cursor for the following page; absent disables "next". */
  nextCursor?: string | undefined;
  prevCursor?: string | undefined;
  onCursor?: ((cursor: string, direction: 'next' | 'prev') => void) | undefined;
  /** Numbered mode: 1-based page and total. Ignored when cursors are present. */
  page?: number | undefined;
  totalPages?: number | undefined;
  onPage?: ((page: number) => void) | undefined;
  /** Already-translated; falls back to the ui.* catalog keys. */
  labelPrevious?: string | undefined;
  labelNext?: string | undefined;
  class?: string | undefined;
}

export function Pagination(props: PaginationProps): JSX.Element {
  const ui = useUi();
  const previous = (): string => props.labelPrevious ?? ui.t(UI_KEYS.previous);
  const next = (): string => props.labelNext ?? ui.t(UI_KEYS.next);
  const cursorMode = (): boolean => props.page === undefined || props.totalPages === undefined;

  return (
    <nav class={cx(styles['pagination'], props.class)} aria-label={ui.t(UI_KEYS.page)}>
      <Button
        variant="secondary"
        size="sm"
        tone="neutral"
        disabled={cursorMode() ? props.prevCursor === undefined : (props.page ?? 1) <= 1}
        onClick={() => {
          if (cursorMode()) {
            if (props.prevCursor !== undefined) props.onCursor?.(props.prevCursor, 'prev');
          } else {
            props.onPage?.(Math.max(1, (props.page ?? 1) - 1));
          }
        }}
      >
        {previous()}
      </Button>

      {cursorMode() ? null : (
        <span class={styles['status']} aria-live="polite">
          {`${props.page ?? 1} / ${props.totalPages ?? 1}`}
        </span>
      )}

      <Button
        variant="secondary"
        size="sm"
        tone="neutral"
        disabled={
          cursorMode()
            ? props.nextCursor === undefined
            : (props.page ?? 1) >= (props.totalPages ?? 1)
        }
        onClick={() => {
          if (cursorMode()) {
            if (props.nextCursor !== undefined) props.onCursor?.(props.nextCursor, 'next');
          } else {
            props.onPage?.(Math.min(props.totalPages ?? 1, (props.page ?? 1) + 1));
          }
        }}
      >
        {next()}
      </Button>
    </nav>
  );
}
