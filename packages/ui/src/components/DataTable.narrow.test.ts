// DataTable's narrow layouts: the card view, column priority and the sticky first column. Split
// from `DataTable.test.ts` by concern — that file holds the four states, sorting and paging.

// Bare, as `index.ts` imports it: the server's `useUi()` reader (issue #490).
import '../theme/ambient';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import {
  byTag,
  isProbeNode,
  nodesOf,
  one,
  type ProbeNode,
  probe,
  renderNodes,
  unprobe,
  withAttr,
} from '../jsx-probe';
import { DataTable } from './DataTable';

const uiString = (key: string): string => FRAMEWORK_CATALOG[key] ?? `no catalog entry for ${key}`;

interface Row {
  id: string;
  name: string;
  total: number;
}

const ROWS: Row[] = [
  { id: 'r1', name: 'alpha', total: 3 },
  { id: 'r2', name: 'beta', total: 5 },
];

const COLUMNS = [
  { key: 'name', header: 'Name', cell: (row: Row): string => row.name, sortable: true },
  { key: 'total', header: 'Total', cell: (row: Row): string => String(row.total), numeric: true },
];

const table = (extra: Record<string, unknown> = {}): ProbeNode[] =>
  renderNodes(DataTable, {
    caption: 'Invoices',
    columns: COLUMNS,
    rows: ROWS,
    rowKey: (row: Row): string => row.id,
    ...extra,
  });

/**
 * The mobile card view is the SAME table restyled, never a second copy: a duplicate view is either
 * read twice or, hidden with `aria-hidden`, a set of links and buttons the screen-reader user is
 * told are not there. The cost of restyling is that WebKit drops a table's semantics once its
 * `display` changes, so every element re-declares its role — that is what these tests hold.
 */
describe('DataTable, narrow tables collapse to labelled cards', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('every table element re-declares its role, so a display change keeps the table a table', () => {
    const nodes = table();
    expect(one(byTag(nodes, 'table'), '<table>').props['role']).toBe('table');
    expect(byTag(nodes, 'thead').map((node) => node.props['role'])).toEqual(['rowgroup']);
    expect(byTag(nodes, 'tbody').map((node) => node.props['role'])).toEqual(['rowgroup']);
    expect(new Set(byTag(nodes, 'tr').map((node) => node.props['role']))).toEqual(new Set(['row']));
    expect(byTag(nodes, 'th').map((node) => node.props['role'])).toEqual([
      'columnheader',
      'columnheader',
    ]);
    expect(new Set(byTag(nodes, 'td').map((node) => node.props['role']))).toEqual(
      new Set(['cell']),
    );
  });

  test('the placeholder rows are rows of cells too', () => {
    const nodes = table({ rows: [], loading: true, skeletonRows: 2 });
    expect(new Set(byTag(nodes, 'td').map((node) => node.props['role']))).toEqual(
      new Set(['cell']),
    );
  });

  test('each cell carries its own column header as the card label, hidden from the reader', () => {
    const nodes = table();
    const headers = byTag(nodes, 'th').map((node) => labelText(node));
    const labels = byTag(nodes, 'td').map((cell) => {
      const label = one(withAttr(nodesOf(cell.props['children']), 'data-label'), 'card label');
      // The column header already names the cell for a screen reader: read twice, it is noise.
      expect(label.props['aria-hidden']).toBe('true');
      return label.props['children'];
    });
    expect(headers).toEqual(['Name', 'Total']);
    expect(labels).toEqual(['Name', 'Total', 'Name', 'Total']);
  });

  test('the cell value still renders beside its label', () => {
    expect(byTag(table(), 'td').map(cellValue)).toEqual(['alpha', '3', 'beta', '5']);
  });

  test('`narrow="scroll"` keeps the scrolling table and renders no label', () => {
    const nodes = table({ narrow: 'scroll' });
    expect(one(byTag(nodes, 'div'), 'wrap').props['data-narrow']).toBe('scroll');
    expect(
      byTag(nodes, 'td').flatMap((cell) => withAttr(nodesOf(cell.props['children']), 'data-label')),
    ).toEqual([]);
    expect(one(byTag(table(), 'div'), 'wrap').props['data-narrow']).toBe('cards');
  });
});

describe('DataTable, column priority hides a cell and keeps its value', () => {
  beforeAll(probe);
  afterAll(unprobe);

  const PRIORITISED = [
    COLUMNS[0],
    { ...COLUMNS[1], priority: 2 },
    { key: 'id', header: 'Id', cell: (row: Row): string => row.id, priority: 3 },
  ];

  test('a lower-priority column marks its header and every cell with its priority', () => {
    const nodes = table({ columns: PRIORITISED });
    const priorities = (tag: string): unknown[] =>
      byTag(nodes, tag)
        .filter((node) => node.props['data-more'] === undefined)
        .map((node) => node.props['data-priority']);
    expect(priorities('th')).toEqual([undefined, '2', '3']);
    expect(priorities('td')).toEqual([undefined, '2', '3', undefined, '2', '3']);
  });

  test('every hidden value is ALSO in the row’s disclosure, labelled — no data is lost', () => {
    const nodes = table({ columns: PRIORITISED });
    const more = byTag(nodes, 'td').filter((node) => node.props['data-more'] !== undefined);
    expect(more).toHaveLength(2);
    expect(more.map((cell) => cell.props['data-more'])).toEqual(['lg', 'lg']);

    const firstRow = nodesOf(more[0]?.props['children']);
    expect(one(byTag(firstRow, 'summary'), '<summary>').props['children']).toBe(
      uiString(UI_KEYS.more),
    );
    expect(byTag(firstRow, 'dt').map((node) => node.props['children'])).toEqual(['Total', 'Id']);
    expect(byTag(firstRow, 'dd').map((node) => node.props['children'])).toEqual(['3', 'r1']);
    // Each entry is shown only while its own cell is hidden, so the value is never on screen twice.
    expect(withAttr(firstRow, 'data-priority').map((node) => node.props['data-priority'])).toEqual([
      '2',
      '3',
    ]);
  });

  test('the disclosure column has a header, so the row and the header row stay the same width', () => {
    const nodes = table({ columns: PRIORITISED });
    const heads = byTag(nodes, 'th');
    expect(heads).toHaveLength(4);
    expect(heads[3]?.props['data-more']).toBe('lg');
    expect(heads[3]?.props['role']).toBe('columnheader');
  });

  test('a disclosure that only holds priority-2 values shows until md, not lg', () => {
    const nodes = table({ columns: [COLUMNS[0], { ...COLUMNS[1], priority: 2 }] });
    expect(byTag(nodes, 'th')[2]?.props['data-more']).toBe('md');
  });

  test('a table that hides nothing renders no disclosure at all', () => {
    const nodes = table();
    expect(byTag(nodes, 'details')).toEqual([]);
    expect(withAttr(nodes, 'data-more')).toEqual([]);
  });

  test('placeholder rows carry the same priorities and the disclosure cell', () => {
    const nodes = table({ columns: PRIORITISED, rows: [], loading: true, skeletonRows: 1 });
    expect(byTag(nodes, 'td').map((node) => node.props['data-priority'])).toEqual([
      undefined,
      '2',
      '3',
      undefined,
    ]);
  });

  test('a priority that is not one is refused by code', () => {
    expect(() => table({ columns: [{ ...COLUMNS[0], priority: 7 }] })).toThrow(
      /X_UI_INVALID_VALUE/,
    );
  });
});

describe('DataTable, stickyFirstColumn', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('is handed to the table, and off unless asked for', () => {
    expect(one(byTag(table(), 'table'), '<table>').props['data-sticky-first']).toBeUndefined();
    expect(
      one(byTag(table({ stickyFirstColumn: true }), 'table'), '<table>').props['data-sticky-first'],
    ).toBe('');
  });
});

/** The visible text of a header, whether it is plain text or a sort control. */
function labelText(th: ProbeNode): unknown {
  const children = th.props['children'];
  if (typeof children === 'string') return children;
  const control = nodesOf(children).find((node) => node.type === 'button' || node.type === 'a');
  const inner = control?.props['children'];
  return Array.isArray(inner) ? inner[0] : inner;
}

/** A cell's content with its card label taken out. */
function cellValue(cell: ProbeNode): unknown {
  const children = cell.props['children'];
  const rest = (Array.isArray(children) ? children : [children]).filter(
    (child) => !(isProbeNode(child) && child.props['data-label'] !== undefined),
  );
  return rest.length === 1 ? rest[0] : rest;
}
