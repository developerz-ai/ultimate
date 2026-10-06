// Data-driven table: sortable headers, cursor pagination, and the four states a
// real list always has (loading, error, empty, data). The error state renders an
// UltimateError with the same code/cause/fix strings the terminal prints.
//
// The four-way decision itself is NOT here — it is `asyncBranch`, shared with `AsyncRegion`, so a
// table and a card list cannot disagree about what "loading with stale rows" looks like. Only the
// PLACEHOLDER is local, because a table's is table-shaped: rows of cells, not lines of text.
//
// A narrow table is the SAME table restyled as labelled cards (`DataTable.module.scss`), never a
// second copy: a duplicate is read twice or, hidden, is links the reader is told are not there.

import { type AsyncState, finiteCount } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { type AsyncBranch, asyncBranch, isBusyBranch } from './async-branch';
import styles from './DataTable.module.scss';
import {
  type ColumnPriority,
  columnPriority,
  type MoreColumn,
  moreColumn,
  priorityAttr,
  TABLE_ROLES,
} from './data-table-view';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Pagination } from './Pagination';
import { Skeleton } from './Skeleton';
import { ariaSortFor, nextSortState, type SortState } from './sort-state';
import { Table } from './Table';

export interface Column<Row> {
  /** Stable identifier; also the sort key sent to the query. */
  key: string;
  /** Already-translated header text. */
  header: string;
  cell: (row: Row) => JSX.Element;
  sortable?: boolean | undefined;
  /** Right-aligns in LTR and left-aligns in RTL via `text-align: end`. */
  numeric?: boolean | undefined;
  width?: string | undefined;
  /**
   * 1 (default) is a cell at every width; 2 hides the cell while the TABLE is narrower than `md`,
   * 3 while it is narrower than `lg`. A hidden value moves into the row's "more" disclosure, so it
   * is never lost — which renders `cell` a second time: give a priority to columns that SHOW a
   * value, never to one holding a form control or a fixed `id`.
   */
  priority?: ColumnPriority | undefined;
}

/** Below `sm`, `cards` restacks each row as a labelled card; `scroll` keeps the scrolling table. */
export type DataTableNarrow = 'cards' | 'scroll';

interface DataTableBaseProps<Row> {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  sort?: SortState | undefined;
  loading?: boolean | undefined;
  /** An UltimateError (or anything shaped like one) from the query. */
  error?: unknown | undefined;
  onRetry?: (() => void) | undefined;
  emptyTitle?: string | undefined;
  emptyDescription?: string | undefined;
  /** Opaque cursors from the query result; absent means no further page. */
  nextCursor?: string | undefined;
  prevCursor?: string | undefined;
  stickyHeader?: boolean | undefined;
  /** Pins the first column while the table scrolls sideways. */
  stickyFirstColumn?: boolean | undefined;
  /** What a table narrower than `sm` becomes. Default `cards`. */
  narrow?: DataTableNarrow | undefined;
  density?: 'comfortable' | 'compact' | undefined;
  /** Placeholder row count while loading. Match the usual page size. */
  skeletonRows?: number | undefined;
  class?: string | undefined;
}

/** The pager and the sort headers call back: the table sits in an island. */
export interface DataTableCallbackProps<Row> extends DataTableBaseProps<Row> {
  /** Callback paging. Never beside `hrefFor` — the type refuses the pair. */
  onCursor?: ((cursor: string, direction: 'next' | 'prev') => void) | undefined;
  /** Callback sorting. Never beside `sortHrefFor` — the type refuses the pair. */
  onSortChange?: ((sort: SortState | undefined) => void) | undefined;
  hrefFor?: undefined;
  sortHrefFor?: undefined;
}

/** The pager and the sort headers are anchors: a server-rendered table needs no script. */
export interface DataTableLinkProps<Row> extends DataTableBaseProps<Row> {
  /** Link paging: the URL of the page a cursor names, handed to `<Pagination hrefFor>`. */
  hrefFor: (cursor: string, direction: 'next' | 'prev') => string;
  /**
   * Link sorting: the URL of the list under the NEXT sort state of a header's cycle (`undefined`
   * is "unsorted"). Absent, a sortable header is plain text — never a button with no handler.
   */
  sortHrefFor?: ((sort: SortState | undefined) => string) | undefined;
  onCursor?: undefined;
  onSortChange?: undefined;
}

export type DataTableProps<Row> = DataTableCallbackProps<Row> | DataTableLinkProps<Row>;

export function DataTable<Row>(props: DataTableProps<Row>): JSX.Element {
  const ui = useUi();

  const sortLabel = (key: string): string =>
    ariaSortFor(props.sort, key) === 'ascending'
      ? ui.t(UI_KEYS.sortDescending)
      : ui.t(UI_KEYS.sortAscending);

  /**
   * `rows` is one prop carrying two meanings, and this is where they are separated. An EMPTY array
   * under `loading` is a first page in flight — there is nothing to keep, so the placeholder shows.
   * A NON-EMPTY one is the previous page, which stays on screen dimmed rather than collapsing to a
   * skeleton: re-sorting a table used to blank every row it was about to render again.
   */
  const state = (): AsyncState<readonly Row[]> => {
    if (props.error !== undefined && props.error !== null) {
      return { status: 'failed', error: props.error };
    }
    if (props.loading === true) {
      return props.rows.length === 0
        ? { status: 'pending' }
        : { status: 'refreshing', data: props.rows };
    }
    return { status: 'ready', data: props.rows };
  };

  const branch = (): AsyncBranch<readonly Row[]> => asyncBranch(state());

  const cards = (): boolean => (props.narrow ?? 'cards') === 'cards';
  /** Read through the validator on every render, so a bad priority is refused, never shown. */
  const priorityOf = (column: Column<Row>): string | undefined =>
    priorityAttr(columnPriority(column.priority));

  /** The card label rides inside the cell and is `aria-hidden`: the header already names it. */
  const cellContent = (column: Column<Row>, row: Row): JSX.Element =>
    cards()
      ? [
          // No class: the attribute is the stylesheet's hook, and this span is on every cell.
          <span data-label="" aria-hidden="true">
            {column.header}
          </span>,
          column.cell(row),
        ]
      : column.cell(row);

  /**
   * The hidden columns' values, each entry shown only over the widths its own cell is hidden —
   * a `<details>`, so it opens with scripting off.
   */
  const disclosure = (more: MoreColumn<Column<Row>>, row: Row): JSX.Element => (
    <td role={TABLE_ROLES.cell} class={styles['more']} data-more={more.until}>
      <details class={styles['disclosure']}>
        <summary class={styles['summary']}>{ui.t(UI_KEYS.more)}</summary>
        <dl class={styles['entries']}>
          {more.columns.map((column) => (
            <div class={styles['entry']} data-priority={priorityOf(column)}>
              <dt>{column.header}</dt>
              <dd>{column.cell(row)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </td>
  );

  const body = (): JSX.Element => {
    if (branch().kind === 'pending') {
      // `Array.from({ length: NaN })` is `[]`, so a busy tbody with no placeholders in it is the
      // collapsed layout this state exists to prevent, reported as healthy; `Infinity` asks for
      // 2^53 - 1 elements and dies with a bare, uncoded `RangeError` out of a render. `??` reaches
      // neither, because `NaN` is not nullish. 0 stays legal: a loading table with no placeholders
      // is a choice, and it is a visible one.
      const placeholders = finiteCount('DataTable', 'skeletonRows', props.skeletonRows ?? 5, 0);
      const more = moreColumn(props.columns);
      return Array.from({ length: placeholders }, () => (
        <tr role={TABLE_ROLES.row} class={styles['row']}>
          {props.columns.map((column) => (
            <td role={TABLE_ROLES.cell} class={styles['cell']} data-priority={priorityOf(column)}>
              <Skeleton height="1.1em" />
            </td>
          ))}
          {more === undefined ? null : (
            <td role={TABLE_ROLES.cell} class={styles['more']} data-more={more.until} />
          )}
        </tr>
      ));
    }
    const more = moreColumn(props.columns);
    return props.rows.map((row) => (
      <tr role={TABLE_ROLES.row} class={styles['row']} data-row={props.rowKey(row)}>
        {props.columns.map((column) => (
          <td
            role={TABLE_ROLES.cell}
            class={cx(styles['cell'], column.numeric === true && styles['numeric'])}
            data-priority={priorityOf(column)}
          >
            {cellContent(column, row)}
          </td>
        ))}
        {more === undefined ? null : disclosure(more, row)}
      </tr>
    ));
  };

  /** One mode per use, exactly as `Pagination` declares it — the table only hands it through. */
  const pager = (): JSX.Element =>
    props.hrefFor === undefined ? (
      <Pagination
        nextCursor={props.nextCursor}
        prevCursor={props.prevCursor}
        onCursor={props.onCursor}
      />
    ) : (
      <Pagination
        nextCursor={props.nextCursor}
        prevCursor={props.prevCursor}
        hrefFor={props.hrefFor}
      />
    );

  const indicator = (key: string): JSX.Element => (
    <span aria-hidden="true" class={styles['indicator']}>
      {ariaSortFor(props.sort, key) === 'ascending'
        ? '▲'
        : ariaSortFor(props.sort, key) === 'descending'
          ? '▼'
          : '↕'}
    </span>
  );

  /**
   * One mode per table, as the pager has: an anchor at the next state's URL when the table is
   * linked, a button that calls back when it is not. A linked table with no `sortHrefFor` gets the
   * header text alone — a `<button>` on a page that never hydrates is a control that does nothing.
   */
  /** Whether a header renders a control at all — the card view shows only those headers. */
  const hasSortControl = (column: Column<Row>): boolean =>
    column.sortable === true && (props.hrefFor === undefined || props.sortHrefFor !== undefined);

  const sortControl = (column: Column<Row>): JSX.Element => {
    if (column.sortable !== true) return column.header;
    const label = `${column.header}: ${sortLabel(column.key)}`;
    if (props.hrefFor !== undefined) {
      const sortHrefFor = props.sortHrefFor;
      if (sortHrefFor === undefined) return column.header;
      return (
        <a
          class={styles['sortButton']}
          aria-label={label}
          href={sortHrefFor(nextSortState(props.sort, column.key))}
        >
          {column.header}
          {indicator(column.key)}
        </a>
      );
    }
    const onSortChange = props.onSortChange;
    return (
      <button
        type="button"
        class={styles['sortButton']}
        aria-label={label}
        onClick={() => onSortChange?.(nextSortState(props.sort, column.key))}
      >
        {column.header}
        {indicator(column.key)}
      </button>
    );
  };

  // An array, not a fragment: this package's `.tsx` compiles to two factories (Solid's and render's
  // `h`), and only an array means the same sibling list to both.
  const header = (): JSX.Element => {
    const more = moreColumn(props.columns);
    return (
      <thead
        role={TABLE_ROLES.rowgroup}
        class={styles['head']}
        data-sortable={props.columns.some(hasSortControl) ? '' : undefined}
      >
        <tr role={TABLE_ROLES.row}>
          {props.columns.map((column) => (
            <th
              scope="col"
              role={TABLE_ROLES.columnheader}
              style={column.width === undefined ? undefined : { 'inline-size': column.width }}
              aria-sort={ariaSortFor(props.sort, column.key)}
              class={cx(styles['heading'], column.numeric === true && styles['numeric'])}
              data-priority={priorityOf(column)}
              data-sort-control={hasSortControl(column) ? '' : undefined}
            >
              {sortControl(column)}
            </th>
          ))}
          {more === undefined ? null : (
            <th
              scope="col"
              role={TABLE_ROLES.columnheader}
              class={styles['more']}
              data-more={more.until}
            >
              {ui.t(UI_KEYS.more)}
            </th>
          )}
        </tr>
      </thead>
    );
  };

  const table = (decided: AsyncBranch<readonly Row[]>): JSX.Element => [
    <Table
      caption={props.caption}
      stickyHeader={props.stickyHeader !== false}
      stickyFirstColumn={props.stickyFirstColumn === true}
      explicitRoles
      density={props.density ?? 'comfortable'}
    >
      {header()}
      <tbody
        role={TABLE_ROLES.rowgroup}
        class={cx(styles['body'], decided.kind === 'ready' && decided.busy && styles['stale'])}
        aria-busy={ariaBool(isBusyBranch(decided))}
      >
        {body()}
      </tbody>
    </Table>,
    props.nextCursor === undefined && props.prevCursor === undefined ? null : pager(),
  ];

  /**
   * The branch is decided INSIDE the returned JSX, as `AsyncRegion` does: a component body runs
   * once, so a decision taken there is the decision for the island's whole life — a table that
   * first rendered its error state kept it after the query recovered.
   */
  const content = (): JSX.Element => {
    const decided = branch();
    if (decided.kind === 'failed') {
      return <ErrorState error={decided.error} onRetry={props.onRetry} />;
    }
    // Unreachable while pending, by the shape of `AsyncBranch` rather than by the order of two
    // ifs: "No results" under a first page in flight is the bug that ordering used to stop.
    if (decided.kind === 'empty') {
      return <EmptyState title={props.emptyTitle} description={props.emptyDescription} />;
    }
    return table(decided);
  };

  return (
    <div class={cx(styles['wrap'], props.class)} data-narrow={props.narrow ?? 'cards'}>
      {content()}
    </div>
  );
}
