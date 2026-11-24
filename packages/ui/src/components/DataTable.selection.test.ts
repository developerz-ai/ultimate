// Row selection on the table. Scripting off it is one form of native checkboxes — a box per row
// posting its key, and an "all matching" box posting the FILTER, never a list of ids. With a
// callback it is a click, a Shift range, the grid pattern's keys and the tick-all box; and under a
// real Solid runtime a row that leaves the list leaves the selection.

import '../theme/ambient';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { attachRef, byTag, fire, type RenderNode, renderNodes } from '@ultimat3/core/render-nodes';
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
  byTag(nodes, 'input').filter((node) => node.props['name'] === 'ids');
const boxFor = (nodes: readonly RenderNode[], key: string): RenderNode => {
  const found = boxes(nodes).find((node) => node.props['value'] === key);
  if (found === undefined) return expect.unreachable(`no box for ${key}`);
  return found;
};
const text = (key: string, count: number): string =>
  (FRAMEWORK_CATALOG[key] ?? key).replace('{count}', String(count));
const statusText = (nodes: readonly RenderNode[]): unknown =>
  byTag(nodes, 'p').find((node) => node.props['role'] === 'status')?.props['children'];
/** The one box that posts nothing: the tick-all box, a control of the page, not of the form. */
const pageBoxOf = (nodes: readonly RenderNode[]): RenderNode => {
  const page = byTag(nodes, 'input').find((node) => node.props['name'] === undefined);
  if (page === undefined) return expect.unreachable('no tick-all box');
  return page;
};

/** A key event on a box. */
const key = (k: string, shift = false) => ({
  key: k,
  shiftKey: shift,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  preventDefault: () => {},
});

/** Each box's ref handed an element that records focus: the keyboard's moves, observable. */
function focusable(nodes: readonly RenderNode[]): { focused: () => string | undefined } {
  let focused: string | undefined;
  for (const node of boxes(nodes)) {
    attachRef(node, {
      focus: () => {
        focused = String(node.props['value']);
      },
    });
  }
  return { focused: () => focused };
}

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
    // A plain form control: the browser's own tick is the state the form posts.
    expect(all[0]?.props['onChange']).toBeUndefined();
  });

  test('the bar holds the caller’s actions, and no count: a tick could never update it', () => {
    const nodes = table({ value: NO_SELECTION, actions: 'ARCHIVE' });
    expect(statusText(nodes)).toBeUndefined();
    const bar = byTag(nodes, 'div').find((node) => node.props['role'] === 'group');
    // No `data-count`, so the bar sticks in reach from the first tick, not only from a count.
    expect(bar?.props['data-count']).toBeUndefined();
    expect(JSON.stringify(nodes.map((node) => node.props['children']))).toContain('ARCHIVE');
  });

  test('"all matching" under the row boxes’ own field name is refused', () => {
    expect(() => table({ matching: { ...MATCHING, name: 'ids' } })).toThrow(
      'selection.matching.name and selection.name are both',
    );
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
    fire(boxFor(nodes, 'r2'), 'onClick', { shiftKey: false, currentTarget: { checked: true } });
    expect(seen).toEqual([{ kind: 'keys', keys: ['r2'] }]);
  });

  test('the bar counts the selection in a status region', () => {
    expect(statusText(live({ kind: 'keys', keys: ['r1', 'r3'] }))).toBe(
      text(UI_KEYS.selectionCount, 2),
    );
  });

  test('a change the caller declines leaves each box showing `value`, not the browser’s flip', () => {
    const nodes = live({ kind: 'keys', keys: ['r1'] });
    const ticked = { checked: true };
    fire(boxFor(nodes, 'r2'), 'onClick', { shiftKey: false, currentTarget: ticked });
    const unticked = { checked: false };
    fire(boxFor(nodes, 'r1'), 'onClick', { shiftKey: false, currentTarget: unticked });
    // Both asked, neither was fed back into `value`.
    expect(seen).toHaveLength(2);
    expect([ticked.checked, unticked.checked]).toEqual([false, true]);

    const page = { checked: true, indeterminate: false };
    fire(pageBoxOf(nodes), 'onClick', { currentTarget: page });
    expect(page).toEqual({ checked: false, indeterminate: true });
  });

  test('Shift+click ranges from the last row clicked', () => {
    const nodes = live(NO_SELECTION);
    fire(boxFor(nodes, 'r1'), 'onClick', { shiftKey: false, currentTarget: {} });
    fire(boxFor(nodes, 'r3'), 'onClick', { shiftKey: true, currentTarget: {} });
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

  test('Ctrl+A over a wholly selected page keeps it selected', () => {
    const first = live({ kind: 'keys', keys: ['r2'] });
    fire(boxFor(first, 'r1'), 'onKeyDown', { ...key('a'), ctrlKey: true });
    const all = seen.at(-1);
    if (all === undefined) return expect.unreachable('Ctrl+A answered nothing');
    expect(all).toEqual({ kind: 'keys', keys: ['r2', 'r1', 'r3'] });

    // The caller's answer fed back as `value`, then Ctrl+A again: still every row, so no call.
    const again = live(all);
    fire(boxFor(again, 'r1'), 'onKeyDown', { ...key('a'), ctrlKey: true });
    expect(seen).toEqual([]);
    expect(boxes(again).every((node) => node.props['checked'] === true)).toBe(true);
  });

  test('Down and Up move focus between the boxes', () => {
    const nodes = live(NO_SELECTION);
    const focus = focusable(nodes);
    fire(boxFor(nodes, 'r1'), 'onKeyDown', key('ArrowDown'));
    expect(focus.focused()).toBe('r2');
    fire(boxFor(nodes, 'r2'), 'onKeyDown', key('ArrowDown'));
    expect(focus.focused()).toBe('r3');
    fire(boxFor(nodes, 'r3'), 'onKeyDown', key('ArrowUp'));
    expect(focus.focused()).toBe('r2');
    expect(seen).toEqual([]);
  });

  test('Shift+Down starts its range at the focused box, not at an earlier click', () => {
    const nodes = live(NO_SELECTION);
    fire(boxFor(nodes, 'r1'), 'onClick', { shiftKey: false, currentTarget: {} });
    // Tab carried focus to r2 — no gesture of ours — and Shift+Down ranges from there.
    fire(boxFor(nodes, 'r2'), 'onKeyDown', key('ArrowDown', true));
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r2', 'r3'] });
  });

  test('a run of Shift+Down keeps the range’s first end', () => {
    const nodes = live(NO_SELECTION);
    fire(boxFor(nodes, 'r1'), 'onKeyDown', key('ArrowDown', true));
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r1', 'r2'] });
    // `value` did not move, so the second step shows the span from r1, not from r2.
    fire(boxFor(nodes, 'r2'), 'onKeyDown', key('ArrowDown', true));
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
    const page = pageBoxOf(nodes);
    expect(page.props['aria-checked']).toBe('mixed');
    fire(page, 'onClick', { currentTarget: {} });
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['r2', 'r1', 'r3'] });
  });

  test('with no rows the tick-all box is disabled', () => {
    // A first page in flight: the header and placeholder rows, and nothing to tick.
    const nodes = renderNodes(DataTable, {
      caption: 'Invoices',
      columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
      rows: [],
      loading: true,
      rowKey: (row: Row): string => row.id,
      selection: { name: 'ids', label: () => '', value: NO_SELECTION, onChange: () => {} },
    });
    expect(pageBoxOf(nodes).props['disabled']).toBe(true);
    expect(pageBoxOf(live(NO_SELECTION)).props['disabled']).toBe(false);
  });

  test('a narrow card list keeps the header shown when it holds only the tick-all box', () => {
    const head = (nodes: readonly RenderNode[]): unknown =>
      byTag(nodes, 'thead')[0]?.props['data-controls'];
    expect(head(live(NO_SELECTION))).toBe('');
    // Scripting off there is no tick-all box, and with no sort chip either the header hides.
    expect(head(table({}))).toBeUndefined();
  });

  test('"all matching" selects the filter, and counts the filter’s total', () => {
    const nodes = live(NO_SELECTION, { matching: MATCHING });
    const all = byTag(nodes, 'input').find((node) => node.props['name'] === 'all');
    if (all === undefined) return expect.unreachable('no all-matching box');
    const target = { checked: true };
    fire(all, 'onChange', { currentTarget: target });
    expect(seen.at(-1)).toEqual({ kind: 'matching', filter: 'q=open' });
    // `value` was never fed back: the box shows what the caller holds, not the browser's tick.
    expect(target.checked).toBe(false);

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

  test('a filter that changes under "all matching" calls back with no selection', () => {
    setSolidRuntime(runtimeOf(solid));
    const [filter, setFilter] = solid.createSignal('q=open');
    const [value, setValue] = solid.createSignal<RowSelection>({
      kind: 'matching',
      filter: 'q=open',
    });
    const seen: RowSelection[] = [];
    const dispose = solid.createRoot((done) => {
      DataTable({
        caption: 'Invoices',
        columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
        rows: ROWS,
        rowKey: (row: Row): string => row.id,
        selection: {
          name: 'ids',
          label: (row: Row): string => row.name,
          get value() {
            return value();
          },
          get matching() {
            return { ...MATCHING, filter: filter() };
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
    setFilter('q=closed');
    // The caller's bulk action must not keep acting on the old filter's rows.
    expect(seen).toEqual([NO_SELECTION]);
    expect(value()).toEqual(NO_SELECTION);
    dispose();
  });

  test('the tick-all box is natively indeterminate over some rows, and clears over all', () => {
    setSolidRuntime(runtimeOf(solid));
    const [value, setValue] = solid.createSignal<RowSelection>({ kind: 'keys', keys: ['r2'] });
    const el = { checked: false, indeterminate: false };
    const dispose = solid.createRoot((done) => {
      const nodes = renderNodes(DataTable, {
        caption: 'Invoices',
        columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
        rows: ROWS,
        rowKey: (row: Row): string => row.id,
        selection: {
          name: 'ids',
          label: (row: Row): string => row.name,
          get value() {
            return value();
          },
          onChange: setValue,
        },
      });
      attachRef(pageBoxOf(nodes), el);
      return done;
    });
    expect(el).toEqual({ checked: false, indeterminate: true });
    setValue({ kind: 'keys', keys: ['r1', 'r2', 'r3'] });
    expect(el).toEqual({ checked: true, indeterminate: false });
    setValue(NO_SELECTION);
    expect(el).toEqual({ checked: false, indeterminate: false });
    dispose();
  });
});
