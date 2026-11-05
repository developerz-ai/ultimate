// The keyed-row rule under the REAL Solid runtime: what a live update does to a row whose key
// survived it. The browser build is loaded by file, as `Form.test.ts` does, because `solid-js`
// resolves to the server build under `bun test`, where no computation re-runs.

import '../theme/ambient';
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderNodes } from '@ultimat3/core/render-nodes';
import { invalidValueError } from '../errors';
import type { Accessor } from '../theme/solid-adapter';
import { DataTable } from './DataTable';
import { type KeyedRowsRuntime, keyedRows } from './data-table-rows';

type Solid = typeof import('solid-js');

async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

interface Row {
  readonly id: string;
  readonly title: string;
}

/** A row "node": the `<tr>` object, and a cell whose text a computation keeps current. */
interface Tr {
  readonly key: string;
  cell: string;
  disposed: boolean;
}

describe('keyedRows under a real Solid runtime', () => {
  let solid: Solid;
  let runtime: KeyedRowsRuntime;

  beforeAll(async () => {
    solid = await browserSolid();
    runtime = {
      createSignal: solid.createSignal,
      createRoot: solid.createRoot,
      onCleanup: solid.onCleanup,
    };
  });

  /** The table body: a computation over `rows` that maps them through the keyed rule, as JSX does. */
  function mount(initial: readonly Row[]) {
    const [rows, setRows] = solid.createSignal(initial);
    let rendered: readonly Tr[] = [];
    let builds = 0;
    let failure: unknown;
    const dispose = solid.createRoot((done) => {
      // Inside the owner, as a component body is: the table's disposal releases every row.
      const map = keyedRows<Row, Tr>(
        runtime,
        (row) => row.id,
        (row: Accessor<Row>, key) => {
          builds += 1;
          const tr: Tr = { key, cell: '', disposed: false };
          solid.createComputed(() => {
            tr.cell = row().title;
          });
          solid.onCleanup(() => {
            tr.disposed = true;
          });
          return tr;
        },
      );
      solid.createComputed(() => {
        try {
          rendered = map(rows());
        } catch (error) {
          failure = error;
        }
      });
      return done;
    });
    return {
      set: setRows,
      rendered: () => rendered,
      builds: () => builds,
      failure: () => failure,
      dispose,
    };
  }

  const a: Row = { id: 'a', title: 'A' };
  const b: Row = { id: 'b', title: 'B' };

  test('the same object under its key keeps its node, and builds nothing', () => {
    const table = mount([a, b]);
    const before = table.rendered()[1];
    table.set([{ id: 'a', title: 'A2' }, b]);
    expect(table.rendered()[1]).toBe(before);
    expect(table.builds()).toBe(2);
    table.dispose();
  });

  test('a new object under a kept key keeps the <tr> and redraws its cell', () => {
    const table = mount([a, b]);
    const before = table.rendered()[0];
    table.set([{ id: 'a', title: 'A2' }, b]);
    const after = table.rendered()[0];
    expect(after).toBe(before);
    expect(after?.cell).toBe('A2');
    // And again after a SECOND update: a cell owned by the body's run would be disposed by now.
    table.set([{ id: 'a', title: 'A3' }, b]);
    expect(table.rendered()[0]?.cell).toBe('A3');
    expect(table.builds()).toBe(2);
    table.dispose();
  });

  test('a vanished key releases its node; a returning one is built afresh', () => {
    const table = mount([a, b]);
    const gone = table.rendered()[1];
    table.set([a]);
    expect(gone?.disposed).toBe(true);
    expect(table.rendered()).toHaveLength(1);
    table.set([a, b]);
    expect(table.rendered()[1]).not.toBe(gone);
    expect(table.builds()).toBe(3);
    table.dispose();
  });

  test('order follows the rows, nodes follow the keys', () => {
    const table = mount([a, b]);
    const [first, second] = table.rendered();
    table.set([b, a]);
    expect(table.rendered()).toEqual([second, first].filter((tr): tr is Tr => tr !== undefined));
    table.dispose();
  });

  test('two rows under one key are X_UI_INVALID_VALUE, naming the key', () => {
    const table = mount([a, { id: 'a', title: 'again' }]);
    expect(table.failure()).toMatchObject({ code: 'X_UI_INVALID_VALUE' });
    expect(String((table.failure() as { cause?: unknown }).cause)).toContain('"a"');
    table.dispose();
  });

  test('a row whose build throws releases what it had built, and is built afresh next time', () => {
    let released = 0;
    let fail = true;
    let rendered: readonly string[] = [];
    let failure: unknown;
    const [rows, setRows] = solid.createSignal<readonly Row[]>([a]);
    const dispose = solid.createRoot((done) => {
      const map = keyedRows<Row, string>(
        runtime,
        (row) => row.id,
        (row, key) => {
          solid.onCleanup(() => {
            released += 1;
          });
          // Input, not a verdict: a column's `cell` that throws on the data it was handed.
          if (fail)
            throw invalidValueError('DataTable', row().title, 'a cell this column can draw');
          return key;
        },
      );
      solid.createComputed(() => {
        try {
          rendered = map(rows());
        } catch (error) {
          failure = error;
        }
      });
      return done;
    });
    expect(failure).toBeDefined();
    expect(released).toBe(1);
    fail = false;
    setRows([{ ...a }]);
    expect(rendered).toEqual(['a']);
    dispose();
    expect(released).toBe(2);
  });

  test('disposing the table releases every row', () => {
    const table = mount([a, b]);
    const nodes = table.rendered();
    table.dispose();
    expect(nodes.every((tr) => tr.disposed)).toBe(true);
  });
});

/** The rule is the table's, not only this module's: a server render of `DataTable` refuses too. */
describe('DataTable answers a duplicate rowKey', () => {
  test('two rows under one key are X_UI_INVALID_VALUE at render', () => {
    const render = (): unknown =>
      renderNodes(DataTable, {
        caption: 'Rows',
        columns: [{ key: 'id', header: 'Id', cell: (row: Row): string => row.title }],
        rows: [
          { id: 'a', title: 'one' },
          { id: 'a', title: 'two' },
        ],
        rowKey: (row: Row): string => row.id,
      });
    expect(render).toThrow(expect.objectContaining({ code: 'X_UI_INVALID_VALUE' }));
  });
});
