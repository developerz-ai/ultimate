// Presentational table. Owns what every hand-rolled table gets wrong: a sticky header, a first
// column that stays put while the rest scrolls, and horizontal overflow contained inside the
// table's own scroll container so the page body never scrolls sideways.

import type { JSX } from 'solid-js';
import { cx } from '../cx';
import styles from './Table.module.scss';

export interface TableProps {
  /** Already-translated caption. Required: a table needs an accessible name. */
  caption: string;
  children: JSX.Element;
  /** Hide the caption visually while keeping it for assistive tech. */
  hideCaption?: boolean | undefined;
  stickyHeader?: boolean | undefined;
  /** Pins the first column at the inline start while the table scrolls sideways. Off by default. */
  stickyFirstColumn?: boolean | undefined;
  /**
   * Declares `role="table"` on the element itself. For a caller that restyles the table's
   * `display` (DataTable's card view): WebKit drops a table's semantics once `display` changes,
   * and the explicit role is what keeps it a table. The rows and cells are the caller's to mark.
   */
  explicitRoles?: boolean | undefined;
  density?: 'comfortable' | 'compact' | undefined;
  /** Zebra striping. Off by default — a border is usually enough. */
  striped?: boolean | undefined;
  class?: string | undefined;
}

export function Table(props: TableProps): JSX.Element {
  return (
    // tabindex makes the scroll region keyboard-reachable, which is required whenever a scrollable
    // element has no focusable children. No `aria-label`: it would OVERRIDE the <caption> as the
    // accessible name rather than add to it, naming the scroll box the same thing as the table
    // inside it — and a <section> with no name is generic, so the table keeps its own caption.
    <section class={cx(styles['scroller'], props.class)} tabindex="0">
      <table
        role={props.explicitRoles === true ? 'table' : undefined}
        // An attribute, not a class: it is state the stylesheet and a test both read.
        data-sticky-first={props.stickyFirstColumn === true ? '' : undefined}
        class={cx(
          styles['table'],
          styles[`density-${props.density ?? 'comfortable'}`],
          props.stickyHeader !== false && styles['sticky'],
          props.striped === true && styles['striped'],
        )}
      >
        <caption class={props.hideCaption === true ? styles['srOnly'] : styles['caption']}>
          {props.caption}
        </caption>
        {props.children}
      </table>
    </section>
  );
}
