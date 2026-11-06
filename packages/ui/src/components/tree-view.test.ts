import { describe, expect, test } from 'bun:test';
import { UiError } from '../errors';
import {
  flattenTree,
  type TreeNode,
  treeAncestors,
  treeMove,
  treeTypeahead,
  visibleTreeIds,
} from './tree-view';

const NODES: readonly TreeNode[] = [
  {
    id: 'docs',
    label: 'Docs',
    children: [
      { id: 'guide', label: 'Guide' },
      { id: 'api', label: 'API', children: [{ id: 'http', label: 'HTTP' }] },
    ],
  },
  { id: 'blog', label: 'Blog', lazy: true },
  { id: 'old', label: 'Old', disabled: true },
];

const FLAT = flattenTree(NODES);

describe('tree arithmetic', () => {
  test('flattening carries level, setsize and posinset for aria', () => {
    expect(
      FLAT.map((entry) => [entry.node.id, entry.level, entry.posinset, entry.setsize]),
    ).toEqual([
      ['docs', 1, 1, 3],
      ['guide', 2, 1, 2],
      ['api', 2, 2, 2],
      ['http', 3, 1, 1],
      ['blog', 1, 2, 3],
      ['old', 1, 3, 3],
    ]);
    expect(FLAT.find((entry) => entry.node.id === 'blog')?.branch).toBe(true);
  });

  test('a closed subtree is skipped by the arrows, and a disabled node is never landed on', () => {
    expect(visibleTreeIds(FLAT, new Set())).toEqual(['docs', 'blog']);
    expect(visibleTreeIds(FLAT, new Set(['docs']))).toEqual(['docs', 'guide', 'api', 'blog']);
    // `http`'s parent is open but its grandparent is not: still hidden.
    expect(visibleTreeIds(FLAT, new Set(['api']))).toEqual(['docs', 'blog']);
    expect(treeMove(FLAT, new Set(), 'docs', 'ArrowDown', 'ltr')).toEqual({
      kind: 'focus',
      id: 'blog',
    });
    expect(treeMove(FLAT, new Set(), 'blog', 'ArrowDown', 'ltr')).toBeUndefined();
    expect(treeMove(FLAT, new Set(['docs']), 'blog', 'End', 'ltr')).toBeUndefined();
    expect(treeMove(FLAT, new Set(['docs']), 'blog', 'Home', 'ltr')).toEqual({
      kind: 'focus',
      id: 'docs',
    });
  });

  test('right opens a closed branch then enters it; left closes then climbs', () => {
    expect(treeMove(FLAT, new Set(), 'docs', 'ArrowRight', 'ltr')).toEqual({
      kind: 'open',
      id: 'docs',
    });
    expect(treeMove(FLAT, new Set(['docs']), 'docs', 'ArrowRight', 'ltr')).toEqual({
      kind: 'focus',
      id: 'guide',
    });
    expect(treeMove(FLAT, new Set(['docs']), 'guide', 'ArrowLeft', 'ltr')).toEqual({
      kind: 'focus',
      id: 'docs',
    });
    expect(treeMove(FLAT, new Set(['docs']), 'docs', 'ArrowLeft', 'ltr')).toEqual({
      kind: 'close',
      id: 'docs',
    });
    expect(treeMove(FLAT, new Set(), 'guide', 'ArrowRight', 'ltr')).toBeUndefined();
  });

  test('dir flips left and right', () => {
    expect(treeMove(FLAT, new Set(), 'docs', 'ArrowLeft', 'rtl')).toEqual({
      kind: 'open',
      id: 'docs',
    });
    expect(treeMove(FLAT, new Set(['docs']), 'docs', 'ArrowRight', 'rtl')).toEqual({
      kind: 'close',
      id: 'docs',
    });
  });

  test('type-ahead finds the next visible label, wrapping, in the given locale', () => {
    const open = new Set(['docs']);
    expect(treeTypeahead(FLAT, open, 'docs', 'a', 'en')).toBe('api');
    expect(treeTypeahead(FLAT, open, 'blog', 'd', 'en')).toBe('docs');
    expect(treeTypeahead(FLAT, open, 'docs', 'h', 'en')).toBeUndefined();
  });

  test('a selected node’s ancestors are what must open for it to show', () => {
    expect(treeAncestors(FLAT, 'http')).toEqual(['api', 'docs']);
    expect(treeAncestors(FLAT, undefined)).toEqual([]);
  });

  test('a repeated id, or a node inside its own subtree, is X_UI_INVALID_VALUE', () => {
    const cycle: { id: string; label: string; children: TreeNode[] } = {
      id: 'loop',
      label: 'Loop',
      children: [],
    };
    cycle.children.push(cycle);
    for (const [nodes, words] of [
      [[cycle], 'its own ancestor'],
      [
        [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
        'repeats',
      ],
    ] as const) {
      try {
        flattenTree(nodes);
        expect.unreachable('an invalid tree was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(UiError);
        expect((error as UiError).message).toContain(words);
      }
    }
  });
});
