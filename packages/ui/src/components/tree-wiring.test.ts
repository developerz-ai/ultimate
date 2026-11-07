// Select-mode Tree driven through its one root keydown and its items' clicks, re-walked after each
// so the accessors the items read show the new state: Enter selects and opens a branch, arrows and
// type-ahead move focus to the DOM item they name, a modified letter is no type-ahead, a disabled
// item ignores its click, and a lazy branch shows it is loading until its children arrive.

import '../theme/ambient';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  attachRef,
  fire,
  nodesOf,
  one,
  type RenderNode,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { syncRuntime } from '../browser-fake-fixture';
import { FakeElement, type InstalledDom, installFakeDom } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Tree } from './Tree';
import type { TreeNode } from './tree-view';

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
  { id: 'archive', label: 'Archive', disabled: true },
  { id: 'remote', label: 'Remote', lazy: true },
];

let dom: InstalledDom | undefined;
afterEach(() => {
  dom?.restore();
  dom = undefined;
  clearSolidRuntime();
});

/** A tree item the DOM half reads: its id in `dataset`, `closest` answering itself. */
const item = (id: string): FakeElement => {
  const el = new FakeElement('li', { role: 'treeitem', 'data-tree-id': id, tabindex: '-1' });
  Object.assign(el, { dataset: { treeId: id }, closest: () => el });
  return el;
};

const mount = (extra: Record<string, unknown> = {}) => {
  const root = new FakeElement('ul');
  const items = new Map(['docs', 'guide', 'api', 'blog', 'remote'].map((id) => [id, item(id)]));
  root.append(...items.values());
  dom = installFakeDom(new FakeElement('div').append(root));
  const rt = syncRuntime();
  setSolidRuntime(rt.runtime);
  const selected: string[] = [];
  const output = Tree({
    nodes: NODES,
    label: 'Files',
    onSelect: (id: string) => selected.push(id),
    ...extra,
  } as never);
  const nodes = (): RenderNode[] => nodesOf(output);
  const tree = one(withAttr(nodes(), 'role', 'tree'), 'tree');
  attachRef(tree, root);
  const key = (on: string, k: string, mods: Record<string, boolean> = {}) => {
    const event = {
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
      target: items.get(on) ?? null,
      prevented: false,
      preventDefault(): void {
        event.prevented = true;
      },
    };
    fire(tree, 'onKeyDown', event);
    return event;
  };
  const ids = (): unknown[] =>
    withAttr(nodes(), 'role', 'treeitem').map((node) => node.props['data-tree-id']);
  const attr = (id: string, name: string): unknown =>
    one(withAttr(nodes(), 'data-tree-id', id), id).props[name];
  return { nodes, items, selected, key, ids, attr, memos: rt.memos };
};

describe('Tree select mode, wired', () => {
  test('Enter selects a branch and opens it; Space closes it again', () => {
    const t = mount();
    expect(t.ids()).toEqual(['docs', 'blog', 'archive', 'remote']);
    const enter = t.key('docs', 'Enter');
    expect(enter.prevented).toBe(true);
    expect(t.selected).toEqual(['docs']);
    expect(t.ids()).toEqual(['docs', 'guide', 'api', 'blog', 'archive', 'remote']);
    expect(t.attr('docs', 'aria-expanded')).toBe('true');
    t.key('docs', ' ');
    expect(t.ids()).toEqual(['docs', 'blog', 'archive', 'remote']);
  });

  test('ArrowDown focuses the next DOM item and moves the tab stop; ArrowRight opens a branch', () => {
    const t = mount();
    t.key('docs', 'ArrowDown');
    expect(t.items.get('blog')?.focusCount).toBe(1);
    expect(t.attr('blog', 'tabIndex')).toBe(0);
    expect(t.attr('docs', 'tabIndex')).toBe(-1);
    const right = t.key('docs', 'ArrowRight');
    expect(right.prevented).toBe(true);
    expect(t.attr('docs', 'aria-expanded')).toBe('true');
    expect(t.selected).toEqual([]);
  });

  test('a letter jumps to the next match; with a modifier it is no type-ahead', () => {
    const t = mount();
    t.key('docs', 'b', { ctrlKey: true });
    expect(t.items.get('blog')?.focusCount).toBe(0);
    t.key('docs', 'b');
    expect(t.items.get('blog')?.focusCount).toBe(1);
    t.key('docs', 'z');
    expect(t.attr('blog', 'tabIndex')).toBe(0);
  });

  test('a key on something that is not a tree item, or one no move answers, is left alone', () => {
    const t = mount();
    const tree = one(withAttr(t.nodes(), 'role', 'tree'), 'tree');
    const stray = { key: 'ArrowDown', target: null, preventDefault: () => {} };
    fire(tree, 'onKeyDown', stray);
    const up = t.key('docs', 'ArrowUp');
    expect(up.prevented).toBe(false);
    expect(t.attr('docs', 'tabIndex')).toBe(0);
  });

  test('a click activates the item clicked and stops there; a disabled item ignores it', () => {
    const t = mount();
    let stopped = 0;
    const click = { stopPropagation: () => (stopped += 1) };
    fire(one(withAttr(t.nodes(), 'data-tree-id', 'blog'), 'blog'), 'onClick', click);
    fire(one(withAttr(t.nodes(), 'data-tree-id', 'archive'), 'archive'), 'onClick', click);
    expect(t.selected).toEqual(['blog']);
    expect(stopped).toBe(2);
  });

  test('a lazy branch is busy while onExpand runs, then shows what it answered — once', async () => {
    const asked: string[] = [];
    let answer: (children: readonly TreeNode[]) => void = () => {};
    const t = mount({
      onExpand: (id: string) => {
        asked.push(id);
        return new Promise<readonly TreeNode[]>((resolve) => {
          answer = resolve;
        });
      },
    });
    t.key('remote', 'Enter');
    expect(t.attr('remote', 'aria-busy')).toBe('true');
    answer([{ id: 'r1', label: 'Remote one' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.attr('remote', 'aria-busy')).toBeUndefined();
    // The root list was drawn once; what an island re-draws from is Tree's first memo.
    const loaded = t.memos[0]?.() as readonly TreeNode[];
    expect(loaded.find((node) => node.id === 'remote')?.children).toEqual([
      { id: 'r1', label: 'Remote one' },
    ]);
    t.key('remote', 'Enter');
    t.key('remote', 'Enter');
    expect(asked).toEqual(['remote']);
  });
});
