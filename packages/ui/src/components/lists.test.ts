// The list components' WIRING, through the props their elements carry: which element holds the tab
// stop, what a link-mode tree renders with no script, and the markup a fact list and a timeline
// emit. The arithmetic under them is tested in their `*-view.test.ts`.

import { describe, expect, test } from 'bun:test';
import { byTag, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { DescriptionList } from './DescriptionList';
import { Timeline } from './Timeline';
import { Tree } from './Tree';
import type { TreeNode } from './tree-view';
import { VirtualList } from './VirtualList';

const NODES: readonly TreeNode[] = [
  {
    id: 'docs',
    label: 'Docs',
    children: [
      { id: 'guide', label: 'Guide' },
      { id: 'api', label: 'API' },
    ],
  },
  { id: 'blog', label: 'Blog' },
];

const tabStops = (nodes: ReturnType<typeof renderNodes>): unknown[] =>
  withAttr(nodes, 'role', 'treeitem').map((node) => node.props['tabIndex']);

describe('Tree', () => {
  test('select mode is one tab stop, on the selected node, with its ancestors open', () => {
    const nodes = renderNodes(Tree, {
      nodes: NODES,
      label: 'Files',
      selected: 'api',
      onSelect: (): void => {},
    });
    expect(withAttr(nodes, 'role', 'tree')).toHaveLength(1);
    // docs (open, because api is inside it), guide, api, blog: one 0, every other -1.
    expect(tabStops(nodes)).toEqual([-1, -1, 0, -1]);
    const docs = withAttr(nodes, 'data-tree-id', 'docs')[0];
    expect(docs?.props['aria-expanded']).toBe('true');
    expect(
      withAttr(nodes, 'aria-selected', 'true').map((node) => node.props['data-tree-id']),
    ).toEqual(['api']);
  });

  test('select mode with nothing selected puts the stop on the first node', () => {
    const nodes = renderNodes(Tree, { nodes: NODES, label: 'Files', onSelect: (): void => {} });
    // Closed: only the two roots render.
    expect(tabStops(nodes)).toEqual([0, -1]);
  });

  test('link mode adds no tab stop and no role: details, summaries and links, 0 B of script', () => {
    const nodes = renderNodes(Tree, {
      nodes: NODES,
      label: 'Files',
      selected: 'guide',
      hrefFor: (node: TreeNode) => `/files/${node.id}`,
    });
    expect(nodes.filter((node) => 'tabIndex' in node.props || 'tabindex' in node.props)).toEqual(
      [],
    );
    expect(withAttr(nodes, 'role', 'tree')).toEqual([]);
    expect(byTag(nodes, 'a').map((node) => node.props['href'])).toEqual([
      '/files/guide',
      '/files/api',
      '/files/blog',
    ]);
    expect(byTag(nodes, 'summary')).toHaveLength(1);
    // The selected leaf is the page, alone, and its branch renders open.
    expect(withAttr(nodes, 'aria-current', 'page').map((node) => node.props['href'])).toEqual([
      '/files/guide',
    ]);
    expect(byTag(nodes, 'details')[0]?.props['open']).toBe(true);
  });
});

describe('DescriptionList', () => {
  test('one div per pair, each holding its dt and dd', () => {
    const nodes = renderNodes(DescriptionList, {
      items: [
        { term: 'Author', detail: 'Ada' },
        { term: 'Likes', detail: '3' },
      ],
    });
    expect(byTag(nodes, 'dl')).toHaveLength(1);
    expect(byTag(nodes, 'dt').map((node) => node.props['children'])).toEqual(['Author', 'Likes']);
    expect(byTag(nodes, 'dd').map((node) => node.props['children'])).toEqual(['Ada', '3']);
    // The wrapper, then one group per pair: a pair stays together when the list stacks.
    expect(byTag(nodes, 'div')).toHaveLength(3);
  });
});

describe('Timeline', () => {
  test('an ordered list per day, keyed rows, the header said once per run', () => {
    const nodes = renderNodes(Timeline, {
      label: 'Activity',
      items: [
        { key: 'a', when: 'today', title: 'One', group: 'Mon' },
        { key: 'b', when: 'today', title: 'Two', group: 'Mon' },
        { key: 'c', when: 'today', title: 'Three', group: 'Tue' },
      ],
      groupBy: (item: { group: string }) => item.group,
    });
    expect(byTag(nodes, 'ol').map((node) => node.props['aria-label'])).toEqual(['Mon', 'Tue']);
    expect(byTag(nodes, 'li').map((node) => node.props['data-key'])).toEqual(['a', 'b', 'c']);
  });
});

describe('VirtualList', () => {
  const props = (items: readonly { id: string }[]): Record<string, unknown> => ({
    items,
    itemKey: (item: { id: string }) => item.id,
    renderItem: (item: { id: string }) => item.id,
    label: 'Rows',
  });

  test('a server render draws every row, with the true count and position on each', () => {
    const items = Array.from({ length: 300 }, (_, index) => ({ id: `r${String(index)}` }));
    const nodes = renderNodes(VirtualList, props(items));
    const rows = byTag(nodes, 'li');
    expect(rows).toHaveLength(300);
    expect(rows[299]?.props['aria-setsize']).toBe(300);
    expect(rows[299]?.props['aria-posinset']).toBe(300);
    expect(byTag(nodes, 'ul')[0]?.props['role']).toBe('list');
  });

  test('two items under one key is refused before anything renders', () => {
    expect(() => renderNodes(VirtualList, props([{ id: 'a' }, { id: 'a' }]))).toThrow(
      'X_UI_INVALID_VALUE',
    );
  });
});
