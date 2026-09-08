// Data-driven table: sortable headers, cursor pagination, and the four states a
// real list always has (loading, error, empty, data). The error state renders an
// UltimateError with the same code/cause/fix strings the terminal prints.
//
// The four-way decision itself is NOT here — it is `asyncBranch`, shared with `AsyncRegion`, so a
// table and a card list cannot disagree about what "loading with stale rows" looks like. Only the
// PLACEHOLDER is local, because a table's is table-shaped: rows of cells, not lines of text.

import { finiteCount } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { type AsyncBranch, type AsyncState, asyncBranch, isBusyBranch } from './async-branch';
import styles from './DataTable.module.scss';
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
}

export interface DataTableProps<Row> {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  sort?: SortState | undefined;
  onSortChange?: (sort: SortState | undefined) => void;
  loading?: boolean | undefined;
  /** An UltimateError (or anything shaped like one) from the query. */
  error?: unknown | undefined;
  onRetry?: (() => void) | undefined;
  emptyTitle?: string | undefined;
  emptyDescription?: string | undefined;
  /** Opaque cursors from the query result; absent means no further page. */
  nextCursor?: string | undefined;
  prevCursor?: string | undefined;
  onCursor?: ((cursor: string, direction: 'next' | 'prev') => void) | undefined;
  stickyHeader?: boolean | undefined;
  density?: 'comfortable' | 'compact' | undefined;
  /** Placeholder row count while loading. Match the usual page size. */
  skeletonRows?: number | undefined;
  class?: string | undefined;
}

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

  const body = (): JSX.Element => {
    if (branch().kind === 'pending') {
      // `Array.from({ length: NaN })` is `[]`, so a busy tbody with no placeholders in it is the
      // collapsed layout this state exists to prevent, reported as healthy; `Infinity` asks for
      // 2^53 - 1 elements and dies with a bare, uncoded `RangeError` out of a render. `??` reaches
      // neither, because `NaN` is not nullish. 0 stays legal: a loading table with no placeholders
      // is a choice, and it is a visible one.
      const placeholders = finiteCount('DataTable', 'skeletonRows', props.skeletonRows ?? 5, 0);
      return Array.from({ length: placeholders }, () => (
        <tr>
          {props.columns.map(() => (
            <td>
              <Skeleton height="1.1em" />
            </td>
          ))}
        </tr>
      ));
    }
    return props.rows.map((row) => (
      <tr data-row={props.rowKey(row)}>
        {props.columns.map((column) => (
          <td class={column.numeric === true ? styles['numeric'] : undefined}>
            {column.cell(row)}
          </td>
        ))}
      </tr>
    ));
  };

  const decided = branch();
  if (decided.kind === 'failed') {
    return <ErrorState error={decided.error} onRetry={props.onRetry} class={props.class} />;
  }

  // Unreachable while pending, by the shape of `AsyncBranch` rather than by the order of two ifs:
  // "No results" under a first page in flight is the bug that ordering used to be all that stopped.
  if (decided.kind === 'empty') {
    return (
      <EmptyState
        title={props.emptyTitle}
        description={props.emptyDescription}
        class={props.class}
      />
    );
  }

  return (
    <div class={cx(styles['wrap'], props.class)}>
      <Table
        caption={props.caption}
        stickyHeader={props.stickyHeader !== false}
        density={props.density ?? 'comfortable'}
      >
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                scope="col"
                style={column.width === undefined ? undefined : { 'inline-size': column.width }}
                aria-sort={ariaSortFor(props.sort, column.key)}
                class={column.numeric === true ? styles['numeric'] : undefined}
              >
                {column.sortable === true ? (
                  <button
                    type="button"
                    class={styles['sortButton']}
                    aria-label={`${column.header}: ${sortLabel(column.key)}`}
                    onClick={() => props.onSortChange?.(nextSortState(props.sort, column.key))}
                  >
                    {column.header}
                    <span aria-hidden="true" class={styles['indicator']}>
                      {ariaSortFor(props.sort, column.key) === 'ascending'
                        ? '▲'
                        : ariaSortFor(props.sort, column.key) === 'descending'
                          ? '▼'
                          : '↕'}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          class={decided.kind === 'ready' && decided.busy ? styles['stale'] : undefined}
          aria-busy={ariaBool(isBusyBranch(decided))}
        >
          {body()}
        </tbody>
      </Table>
      {props.nextCursor === undefined && props.prevCursor === undefined ? null : (
        <Pagination
          nextCursor={props.nextCursor}
          prevCursor={props.prevCursor}
          onCursor={props.onCursor}
        />
      )}
    </div>
  );
}
