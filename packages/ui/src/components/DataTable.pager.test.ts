// The table's pager over a framework `Page`: `nextCursor` handed straight through (`null` on the
// last page), and the way back — `firstHref` / `onFirst` — handed to `Pagination` in the table's
// own mode. A table with neither a cursor nor a way back is one page, and draws no pager.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import { type Page, pageOf } from '@ultimat3/core';
import { byTag, fire, renderNodes } from '@ultimat3/core/render-nodes';
import { DataTable } from './DataTable';

interface Row {
  readonly id: string;
}

const ROWS: readonly Row[] = [{ id: 'a' }];
const base = {
  caption: 'Rows',
  columns: [{ key: 'id', header: 'Id', cell: (row: Row): string => row.id }],
  rows: ROWS,
  rowKey: (row: Row): string => row.id,
};
const hrefFor = (cursor: string): string => `/rows?after=${cursor}`;

describe('DataTable over a Page', () => {
  test('the last page, first in the list: no pager at all', () => {
    const last: Page<Row> = pageOf(ROWS, null);
    const nodes = renderNodes(DataTable, { ...base, nextCursor: last.nextCursor, hrefFor });
    expect(byTag(nodes, 'nav')).toEqual([]);
  });

  test('a later last page: First links back, and nothing links on', () => {
    const nodes = renderNodes(DataTable, {
      ...base,
      nextCursor: null,
      hrefFor,
      firstHref: '/rows',
    });
    expect(byTag(nodes, 'nav')).toHaveLength(1);
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual(['/rows']);
  });

  test('a page with more: Next, and no Previous a keyset page cannot fill', () => {
    const more: Page<Row> = pageOf(ROWS, 'c2');
    const nodes = renderNodes(DataTable, { ...base, nextCursor: more.nextCursor, hrefFor });
    expect(byTag(nodes, 'a').map((node) => node.props['rel'])).toEqual(['next']);
    expect(byTag(nodes, 'button')).toEqual([]);
  });

  test('callback mode hands onFirst through', () => {
    let first = 0;
    const nodes = renderNodes(DataTable, {
      ...base,
      onCursor: () => {},
      onFirst: () => {
        first += 1;
      },
    });
    const [button] = byTag(nodes, 'button');
    if (button === undefined) return expect.unreachable('onFirst drew no button');
    fire(button, 'onClick', {});
    expect(first).toBe(1);
  });
});
