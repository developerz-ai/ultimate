// DataTable's keyed rows: one cell per `rowKey`, so a live update leaves an unchanged row's DOM —
// its focus, its open "more" disclosure — exactly where it was. Pure over an injected runtime, so
// the rule is proven under real Solid without a renderer; `solid-js` stays a type-only import.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';
import type { Accessor, Setter } from '../theme/solid-adapter';

/**
 * The slice of Solid the rule needs. `createRoot` is the load-bearing one: a row built inside the
 * body's computation is OWNED by it, and Solid disposes what a computation owns each time it
 * re-runs — so a kept node would keep its markup and lose every binding inside it on the next tick.
 */
export interface KeyedRowsRuntime {
  createSignal<T>(value: T): [Accessor<T>, Setter<T>];
  createRoot<T>(fn: (dispose: () => void) => T): T;
  onCleanup(fn: () => void): void;
}

interface Cell<Row, Node> {
  /** The object last seen under this key, held plainly: comparing it must not subscribe the body. */
  row: Row;
  readonly set: Setter<Row>;
  readonly node: Node;
  readonly dispose: () => void;
}

/** Two rows under one key cannot both keep a node. */
function duplicateKeyError(key: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `<DataTable> rowKey answered ${renderCauseValue(key)} for two rows, so one node would have to be both — rowKey must be unique per row`,
    fix: 'rowKey: (row) => row.id   # on <DataTable>: the row primary key, unique within rows',
  });
}

/**
 * Call once, in the component body: the returned map is what the body runs on every update. The
 * same object under a key returns the same node and runs nothing; a new object under a kept key
 * returns the same node and sets its signal, so only the cells reading it redraw; a vanished key
 * disposes its row. Disposing the owner disposes every row.
 */
export function keyedRows<Row, Node>(
  runtime: KeyedRowsRuntime,
  keyOf: (row: Row) => string,
  build: (row: Accessor<Row>, key: string) => Node,
): (rows: readonly Row[]) => Node[] {
  const cells = new Map<string, Cell<Row, Node>>();
  runtime.onCleanup(() => {
    for (const cell of cells.values()) cell.dispose();
    cells.clear();
  });

  const cellFor = (row: Row, key: string): Cell<Row, Node> => {
    const kept = cells.get(key);
    if (kept !== undefined) {
      if (kept.row !== row) {
        kept.row = row;
        kept.set(row);
      }
      return kept;
    }
    const made = runtime.createRoot((dispose) => {
      const [current, set] = runtime.createSignal(row);
      try {
        return { row, set, node: build(current, key), dispose };
      } catch (error) {
        // Never cached, so never disposed by a later run: what the build made so far goes now.
        dispose();
        throw error;
      }
    });
    cells.set(key, made);
    return made;
  };

  return (rows) => {
    const seen = new Set<string>();
    const nodes = rows.map((row) => {
      const key = keyOf(row);
      if (seen.has(key)) throw duplicateKeyError(key);
      seen.add(key);
      return cellFor(row, key).node;
    });
    for (const [key, cell] of cells) {
      if (!seen.has(key)) {
        cell.dispose();
        cells.delete(key);
      }
    }
    return nodes;
  };
}
