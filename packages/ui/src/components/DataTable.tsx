// Data-driven table: sortable headers, cursor pagination, and the four states a
// real list always has (loading, error, empty, data). The error state renders an
// UltimateError with the same code/cause/fix strings the terminal prints.

import type { JSX } from 'solid-js';
import { ariaBool } from '../a11y';
import { cx } from '../cx';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
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

  const body = (): JSX.Element => {
    if (props.loading === true) {
      return Array.from({ length: props.skeletonRows ?? 5 }, () => (
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

  if (props.error !== undefined && props.error !== null) {
    return <ErrorState error={props.error} onRetry={props.onRetry} class={props.class} />;
  }

  if (props.loading !== true && props.rows.length === 0) {
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
        <tbody aria-busy={ariaBool(props.loading === true)}>{body()}</tbody>
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
