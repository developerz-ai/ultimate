// Row selection on the table. Scripting off it is one form of native checkboxes — a box per row
// posting its key, and an "all matching" box posting the FILTER, never a list of ids. With a
// callback it is a click, a Shift range, the grid pattern's keys and the tick-all box; and under a
// real Solid runtime a row that leaves the list leaves the selection.

import '../theme/ambient';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, fire, type RenderNode, renderNodes } from '@ultimat3/core/render-nodes';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { browserSolid, runtimeOf, type Solid } from '../browser-fake-fixture';
import { UI_KEYS } from '../i18n-keys';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { DataTable } from './DataTable';
import { NO_SELECTION, type RowSelection } from './row-selection';

interface Row {
  readonly id: string;
  readonly name: string;
}

const ROWS: readonly Row[] = [
  { id: 'r1', name: 'alpha' },
  { id: 'r2', name: 'beta' },
  { id: 'r3', name: 'gamma' },
];
const MATCHING = { name: 'all', filter: 'q=open', count: 240 };

const table = (selection: Record<string, unknown>, rows: readonly Row[] = ROWS): RenderNode[] =>
  renderNodes(DataTable, {
    caption: 'Invoices',
    columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
    rows,
    rowKey: (row: Row): string => row.id,
    selection: {
      name: 'ids',
      form: 'bulk',
      label: (row: Row): string => `Select ${row.name}`,
      value: NO_SELECTION,
      ...selection,
    },
  });

const boxes = (nodes: readonly RenderNode[]): RenderNode[] =>
  byTag(nodes, 'input').filter((node) => node.props['data-select-key'] !== undefined);
const boxFor = (nodes: readonly RenderNode[], key: string): RenderNode => {
  const found = boxes(nodes).find((node) => node.props['data-select-key'] === key);
  if (found === undefined) return expect.unreachable(`no box for ${key}`);
  return found;
};
const text = (key: string, count: number): string =>
  (FRAMEWORK_CATALOG[key] ?? key).replace('{count}', String(count));
const statusText = (nodes: readonly RenderNode[]): unknown =>
  byTag(nodes, 'p').find((node) => node.props['role'] === 'status')?.props['children'];

/** A key event on a box; `closest` answers no scope, so focus moves nowhere in a node test. */
const key = (k: string, shift = false) => ({
  key: k,
  shiftKey: shift,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  preventDefault: () => {},
  currentTarget: { closest: () => null },
});

describe('DataTable selection with scripting off', () => {
  test('one native checkbox per row, in one form, posting its key', () => {
    const nodes = table({ value: { kind: 'keys', keys: ['r2'] } });
    expect(
      boxes(nodes).map((node) => [
        node.props['type'],
        node.props['name'],
        node.props['value'],
        node.props['form'],
        node.props['checked'],
        node.props['aria-label'],
      ]),
    ).toEqual([
      ['checkbox', 'ids', 'r1', 'bulk', false, 'Select alpha'],
      ['checkbox', 'ids', 'r2', 'bulk', true, 'Select beta'],
      ['checkbox', 'ids', 'r3', 'bulk', false, 'Select gamma'],
    ]);
    // No handler on the server's copy: a box that calls back on a page that never hydrates lies.
    expect(boxes(nodes).every((node) => node.props['onClick'] === undefined)).toBe(true);
  });

  test('no tick-all box: scripting off it could tick nothing', () => {
    const nodes = table({});
    const head = byTag(nodes, 'th')[0];
    expect(head?.props['children']).toBeNull();
    expect(
      byTag(nodes, 'input').filter(
        (node) => node.props['aria-label'] === text(UI_KEYS.selectionPage, 0),
      ),
    ).toEqual([]);
  });

  test('"all matching" is a box posting the FILTER in the same form, never ids', () => {
    const nodes = table({ matching: MATCHING });
    const all = byTag(nodes, 'input').filter((node) => node.props['name'] === 'all');
    expect(all.map((node) => [node.props['value'], node.props['form']])).toEqual([
      ['q=open', 'bulk'],
    ]);
  });

  test('the bar counts the selection in a status region, and holds the caller’s actions', () => {
    const nodes = renderNodes(DataTable, {
      caption: 'Invoices',
      columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
      rows: ROWS,
      rowKey: (row: Row): string => row.id,
      selection: {
        name: 'ids',
        label: (row: Row): string => row.name,
        value: { kind: 'keys', keys: ['r1', 'r3'] },
        actions: 'ARCHIVE',
      },
    });
    expect(statusText(nodes)).toBe(text(UI_KEYS.selectionCount, 2));
    expect(JSON.stringify(nodes.map((node) => node.props['children']))).toContain('ARCHIVE');
  });
});

describe('DataTable selection with a callback', () => {
  const seen: RowSelection[] = [];
  const live = (value: RowSelection, extra: Record<string, unknown> = {}): RenderNode[] => {
    seen.length = 0;
    return table({ value, onChange: (next: RowSelection) => seen.push(next), ...extra });
  };

  test('a click ticks one row', () => {
    const nodes = live(NO_SELECTION);
    fire(boxFor(nodes, 'r2'), 'onClick', { shiftKey: false });
    expect(seen).toEqual([{ kind: 'keys', keys: ['r2'] }]);
  });

  test('Shift+click ranges from the last row clicked', () => {
    const nodes = live(NO_SELECTION);
    fire(boxFor(nodes, 'r1'), 'onClick', { shiftKey: false });
    fire(boxFor(nodes, 'r3'), 'onClick', { shiftKey: true });
    // `value` is the caller's and did not move between the clicks: the range is r1..r3 over it.
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r1', 'r2', 'r3'] });
  });

  test('Shift+ArrowDown extends to the next row; Escape clears; Ctrl+A ticks the page', () => {
    const nodes = live({ kind: 'keys', keys: ['r1'] });
    fire(boxFor(nodes, 'r1'), 'onKeyDown', key('ArrowDown', true));
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r1', 'r2'] });
    fire(boxFor(nodes, 'r1'), 'onKeyDown', key('Escape'));
    expect(seen.at(-1)).toEqual(NO_SELECTION);
    fire(boxFor(nodes, 'r1'), 'onKeyDown', { ...key('a'), ctrlKey: true });
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r1', 'r2', 'r3'] });
  });

  test('Space is left to the native box', () => {
    const nodes = live(NO_SELECTION);
    let prevented = false;
    fire(boxFor(nodes, 'r1'), 'onKeyDown', {
      ...key(' '),
      preventDefault: () => {
        prevented = true;
      },
    });
    expect([prevented, seen]).toEqual([false, []]);
  });

  test('the tick-all box is mixed over some rows and ticks the rest', () => {
    const nodes = live({ kind: 'keys', keys: ['r2'] });
    const page = byTag(nodes, 'input').find(
      (node) => node.props['aria-label'] === text(UI_KEYS.selectionPage, 0),
    );
    if (page === undefined) return expect.unreachable('no tick-all box');
    expect(page.props['aria-checked']).toBe('mixed');
    fire(page, 'onClick', {});
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r2', 'r1', 'r3'] });
  });

  test('"all matching" selects the filter, and counts the filter’s total', () => {
    const nodes = live(NO_SELECTION, { matching: MATCHING });
    const all = byTag(nodes, 'input').find((node) => node.props['name'] === 'all');
    if (all === undefined) return expect.unreachable('no all-matching box');
    fire(all, 'onChange', { currentTarget: { checked: true } });
    expect(seen.at(-1)).toEqual({ kind: 'matching', filter: 'q=open' });

    const chosen = live({ kind: 'matching', filter: 'q=open' }, { matching: MATCHING });
    expect(statusText(chosen)).toBe(text(UI_KEYS.selectionCount, 240));
    expect(boxes(chosen).every((node) => node.props['checked'] === true)).toBe(true);
  });

  test('"all matching" from another filter shows as nothing selected', () => {
    const nodes = live({ kind: 'matching', filter: 'q=closed' }, { matching: MATCHING });
    expect(statusText(nodes)).toBe(text(UI_KEYS.selectionCount, 0));
    expect(boxes(nodes).some((node) => node.props['checked'] === true)).toBe(false);
  });
});

describe('a row that left the list leaves the selection', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });
  afterEach(clearSolidRuntime);

  test('the table calls back with the pruned selection, and never during a first load', () => {
    setSolidRuntime(runtimeOf(solid));
    const [rows, setRows] = solid.createSignal<readonly Row[]>(ROWS);
    const [loading, setLoading] = solid.createSignal(false);
    const [value, setValue] = solid.createSignal<RowSelection>({
      kind: 'keys',
      keys: ['r1', 'r3'],
    });
    const seen: RowSelection[] = [];
    const dispose = solid.createRoot((done) => {
      DataTable({
        caption: 'Invoices',
        columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
        get rows() {
          return rows();
        },
        get loading() {
          return loading();
        },
        rowKey: (row: Row): string => row.id,
        selection: {
          name: 'ids',
          label: (row: Row): string => row.name,
          get value() {
            return value();
          },
          onChange: (next: RowSelection) => {
            seen.push(next);
            setValue(next);
          },
        },
      });
      return done;
    });
    expect(seen).toEqual([]);

    setLoading(true);
    setRows([]);
    expect(seen).toEqual([]);

    setRows(ROWS.filter((row) => row.id !== 'r3'));
    setLoading(false);
    expect(seen).toEqual([{ kind: 'keys', keys: ['r1'] }]);
    dispose();
  });
});
