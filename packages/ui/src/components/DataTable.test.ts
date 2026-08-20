// The four states a real list always has, and the one control the reader can operate. `sort-state`
// already proves the cycle; what it cannot see is whether the header BUTTON sends the cycle's
// answer, whether `aria-sort` lands on the column that is actually sorted, and whether the loading
// state announces itself as busy instead of rendering an empty table.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import { byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { DataTable } from './DataTable';
import type { SortState } from './sort-state';

/**
 * What this component must render for a ui key, looked up BY THE KEY in the catalog it ships in.
 *
 * These assertions read `⟦ui.x⟧` until 5.1.0, because `registerFrameworkCatalog()` had one caller
 * and a unit test was never it — so every framework string was a loud miss here and the marker was
 * the only observable. It is registered by importing `@ultimat3/i18n` now, so the marker is gone;
 * the KEY is still what is asserted, which is what these tests are about.
 */
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
  {
    key: 'total',
    header: 'Total',
    cell: (row: Row): string => String(row.total),
    numeric: true,
    width: '8rem',
  },
];

const table = (extra: Record<string, unknown> = {}): ReturnType<typeof renderNodes> =>
  renderNodes(DataTable, {
    caption: 'Invoices',
    columns: COLUMNS,
    rows: ROWS,
    rowKey: (row: Row): string => row.id,
    ...extra,
  });

describe('DataTable', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the component compiles to a JSX factory this file understands', () => {
    expect(table().length).toBeGreaterThan(0);
  });

  describe('the four states', () => {
    test('data renders one row per row, keyed by the caller’s rowKey', () => {
      const nodes = table();
      const rows = byTag(nodes, 'tr').filter((node) => node.props['data-row'] !== undefined);

      expect(rows.map((node) => node.props['data-row'])).toEqual(['r1', 'r2']);
      expect(byTag(nodes, 'td').map((node) => node.props['children'])).toEqual([
        'alpha',
        '3',
        'beta',
        '5',
      ]);
      expect(one(byTag(nodes, 'caption'), '<caption>').props['children']).toBe('Invoices');
    });

    test('loading announces busy and holds the row height instead of collapsing', () => {
      const nodes = table({ loading: true, skeletonRows: 3 });

      expect(one(byTag(nodes, 'tbody'), '<tbody>').props['aria-busy']).toBe('true');
      expect(
        byTag(nodes, 'tr').filter((node) => node.props['data-row'] === undefined),
      ).toHaveLength(4);
      // 3 placeholder rows × 2 columns.
      expect(byTag(nodes, 'td')).toHaveLength(6);
      // A placeholder that changes size on load is just a slower layout shift.
      expect(
        byTag(nodes, 'span').some(
          (node) => (node.props['style'] as Record<string, string>)?.['--skeleton-h'] === '1.1em',
        ),
      ).toBe(true);
    });

    test('loading beats empty — a first page in flight is not "no results"', () => {
      const nodes = table({ rows: [], loading: true });
      expect(byTag(nodes, 'table')).toHaveLength(1);
    });

    test('no rows and not loading is the empty state, with no table at all', () => {
      const nodes = table({
        rows: [],
        emptyTitle: 'No invoices yet',
        emptyDescription: 'Send one',
      });

      expect(byTag(nodes, 'table')).toEqual([]);
      const text = byTag(nodes, 'p').map((node) => node.props['children']);
      expect(text).toEqual(['No invoices yet', 'Send one']);
    });

    test('an empty state with no title falls back to the catalog, never to English', () => {
      const nodes = table({ rows: [] });
      expect(byTag(nodes, 'p')[0]?.props['children']).toBe(uiString(UI_KEYS.empty));
    });

    test('an error replaces the table with the report, carrying the code verbatim', () => {
      const retries: number[] = [];
      const nodes = table({
        error: new UltimateError({ code: 'X_ID_INVALID', cause: 'not a uuid', fix: 'parseId()' }),
        onRetry: () => retries.push(1),
        rows: [],
      });

      expect(byTag(nodes, 'table')).toEqual([]);
      const text = JSON.stringify(byTag(nodes, 'dd').map((node) => node.props['children']));
      expect(text).toContain('X_ID_INVALID');
      expect(text).toContain('not a uuid');

      fire(one(byTag(nodes, 'button'), 'retry'), 'onClick', {});
      expect(retries).toEqual([1]);
    });

    test('an error wins over the empty state, so a failure is never read as "no data"', () => {
      const nodes = table({ rows: [], error: new TypeError('boom') });
      expect(byTag(nodes, 'dd').length).toBeGreaterThan(0);
      expect(byTag(nodes, 'table')).toEqual([]);
    });
  });

  describe('sorting', () => {
    test('only a sortable column gets a control; the rest are plain header text', () => {
      const nodes = table();
      const headers = byTag(nodes, 'th');

      expect(headers).toHaveLength(2);
      expect(byTag(nodes, 'button')).toHaveLength(1);
      expect(headers[1]?.props['children']).toBe('Total');
      expect(headers[1]?.props['style']).toEqual({ 'inline-size': '8rem' });
      expect(headers[0]?.props['style']).toBeUndefined();
    });

    test('aria-sort is "none" everywhere until a column is sorted, then only on that one', () => {
      expect(byTag(table(), 'th').map((node) => node.props['aria-sort'])).toEqual(['none', 'none']);

      const sorted = table({ sort: { key: 'name', direction: 'desc' } satisfies SortState });
      expect(byTag(sorted, 'th').map((node) => node.props['aria-sort'])).toEqual([
        'descending',
        'none',
      ]);
    });

    test('the control walks the cycle the reducer defines, and hands it to the caller', () => {
      const seen: (SortState | undefined)[] = [];
      const onSortChange = (sort: SortState | undefined): void => void seen.push(sort);

      fire(one(byTag(table({ onSortChange }), 'button'), 'sort'), 'onClick', {});
      fire(
        one(byTag(table({ onSortChange, sort: { key: 'name', direction: 'asc' } }), 'button'), 's'),
        'onClick',
        {},
      );
      fire(
        one(
          byTag(table({ onSortChange, sort: { key: 'name', direction: 'desc' } }), 'button'),
          's',
        ),
        'onClick',
        {},
      );

      expect(seen).toEqual([
        { key: 'name', direction: 'asc' },
        { key: 'name', direction: 'desc' },
        undefined,
      ]);
    });

    test('a table with no sort handler still renders the control instead of throwing', () => {
      expect(() => fire(one(byTag(table(), 'button'), 'sort'), 'onClick', {})).not.toThrow();
    });

    test('the control names the action it will perform, through the catalog', () => {
      const unsorted = one(byTag(table(), 'button'), 'sort');
      expect(unsorted.props['aria-label']).toBe(`Name: ${uiString(UI_KEYS.sortAscending)}`);

      const ascending = one(
        byTag(table({ sort: { key: 'name', direction: 'asc' } }), 'button'),
        'sort',
      );
      // Already ascending, so the next click sorts descending — that is what it must announce.
      expect(ascending.props['aria-label']).toBe(`Name: ${uiString(UI_KEYS.sortDescending)}`);
    });

    test('the direction indicator is decoration, and matches the state it indicates', () => {
      const glyph = (sort: SortState | undefined): unknown =>
        one(withAttr(byTag(table(sort === undefined ? {} : { sort }), 'span'), 'aria-hidden'), 'i')
          .props['children'];

      expect(glyph(undefined)).toBe('↕');
      expect(glyph({ key: 'name', direction: 'asc' })).toBe('▲');
      expect(glyph({ key: 'name', direction: 'desc' })).toBe('▼');
    });
  });

  describe('cursor pagination', () => {
    test('is absent when the query returned no cursors', () => {
      expect(byTag(table(), 'nav')).toEqual([]);
    });

    test('appears for a next page and reports the cursor it was given, with a direction', () => {
      const cursors: [string, string][] = [];
      // No sortable column here, so every button in the tree belongs to the pager.
      const nodes = renderNodes(DataTable, {
        caption: 'Invoices',
        columns: [{ key: 'name', header: 'Name', cell: (row: Row): string => row.name }],
        rows: ROWS,
        rowKey: (row: Row): string => row.id,
        nextCursor: 'c2',
        prevCursor: 'c0',
        onCursor: (cursor: string, direction: string) => void cursors.push([cursor, direction]),
      });

      expect(byTag(nodes, 'nav')).toHaveLength(1);
      const buttons = byTag(nodes, 'button');
      expect(buttons).toHaveLength(2);

      fire(buttons[0] as never, 'onClick', {});
      fire(buttons[1] as never, 'onClick', {});
      expect(cursors).toEqual([
        ['c0', 'prev'],
        ['c2', 'next'],
      ]);
    });

    test('the pager appears for a previous cursor alone, too', () => {
      expect(byTag(table({ prevCursor: 'c0' }), 'nav')).toHaveLength(1);
    });
  });
});
