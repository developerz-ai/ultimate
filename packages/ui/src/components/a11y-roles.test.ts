// The two rules the rendered audit deferred (2026/11/11 slice 15 T3), held here over the catalog's
// own markup: a node in a listbox, menu or tree role carries a non-blank name that is ITS name, and
// nothing reachable by Tab is a generic box a screen reader announces as nothing. Menu's APG Tab:
// the menu closes and the browser's own Tab carries on from the trigger.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import {
  attachRef,
  byTag,
  fire,
  one,
  type RenderNode,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { FakeElement, installFakeDom, keydown } from '../fake-dom-fixture';
import { CodeBlock } from './CodeBlock';
import { DiffView } from './DiffView';
import { Menu } from './Menu';
import { SplitPane } from './SplitPane';
import { Table } from './Table';
import { Tabs } from './Tabs';
import { TerminalView } from './TerminalView';
import { Tree } from './Tree';

/** Elements whose tag alone gives them a role in the accessibility tree. */
const NATIVE_ROLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'iframe']);

const named = (node: RenderNode): boolean =>
  [node.props['aria-label'], node.props['aria-labelledby']].some(
    (value) => typeof value === 'string' && value.trim() !== '',
  );

/** The role a node has with no help: explicit, its tag's, or `section`'s once it is named. */
const roleOf = (node: RenderNode): string | undefined => {
  const explicit = node.props['role'];
  if (typeof explicit === 'string') return explicit;
  if (typeof node.type === 'string' && NATIVE_ROLE.has(node.type)) return node.type;
  if (node.type === 'section' && named(node)) return 'region';
  return undefined;
};

/** Every node a Tab lands on that has no role — the deferred `focusable-without-role` rule. */
const unrolledStops = (nodes: readonly RenderNode[]): RenderNode[] =>
  nodes.filter((node) => {
    const tabindex = node.props['tabindex'] ?? node.props['tabIndex'];
    return tabindex !== undefined && Number(tabindex) >= 0 && roleOf(node) === undefined;
  });

/** Text as name-from-content reads it: strings and numbers, minus every `aria-hidden` subtree. */
const textOf = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (typeof value === 'function') return textOf((value as () => unknown)());
  if (typeof value === 'object' && value !== null && 'props' in value) {
    const props = (value as RenderNode).props;
    return props['aria-hidden'] === 'true' ? '' : textOf(props['children']);
  }
  return '';
};
const spokenText = (node: RenderNode): string => textOf(node.props['children']).trim();

const TABS = [
  { id: 'one', label: 'One', panel: 'first' },
  { id: 'two', label: 'Two', panel: 'second' },
];

describe('focusable-without-role, over every catalog component that sets a tabindex', () => {
  const cases: readonly (readonly [string, unknown, Record<string, unknown>])[] = [
    ['Table', Table, { caption: 'Rows', children: null }],
    ['CodeBlock', CodeBlock, { code: 'x', copy: false }],
    ['DiffView', DiffView, { old: 'a', new: 'b' }],
    ['TerminalView', TerminalView, { text: 'a\nb' }],
    ['SplitPane', SplitPane, { start: 'a', end: 'b', defaultValue: 40 }],
    ['Tabs', Tabs, { items: TABS, value: 'one', onChange: () => {}, label: 'Sections' }],
  ];
  for (const [name, component, props] of cases) {
    test(`${name}: every tab stop has a role`, () => {
      const nodes = renderNodes(component, props);
      expect(nodes.some((node) => node.props['tabindex'] !== undefined)).toBe(true);
      expect(unrolledStops(nodes).map((node) => node.type)).toEqual([]);
    });
  }

  test('Table: the scroll box is a region named with the caption, the table keeps its caption', () => {
    const nodes = renderNodes(Table, { caption: 'Rows', children: null });
    const box = one(byTag(nodes, 'section'), '<section>');
    expect(roleOf(box)).toBe('region');
    expect(box.props['aria-label']).toBe('Rows');
    expect(one(byTag(nodes, 'caption'), '<caption>').props['children']).toBe('Rows');
    expect(one(byTag(nodes, 'table'), '<table>').props['aria-label']).toBeUndefined();
  });
});

const FILES = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'a', label: 'a.ts' },
      { id: 'b', label: 'b.ts' },
    ],
  },
  { id: 'lazy', label: 'vendor', lazy: true },
];

describe('named roles: treeitem and menuitem carry their own name', () => {
  test('a branch is named by its label alone, never its children or its loading text', () => {
    const nodes = renderNodes(Tree, {
      nodes: FILES,
      label: 'Files',
      open: ['src'],
      onSelect: () => {},
    });
    const items = withAttr(nodes, 'role', 'treeitem');
    expect(items.map((node) => node.props['aria-label'])).toEqual([
      'src',
      'a.ts',
      'b.ts',
      'vendor',
    ]);
  });

  test('every menuitem is named by its label', () => {
    const nodes = renderNodes(Menu, {
      items: [
        { id: 'edit', label: 'Edit', onSelect: () => {} },
        { id: 'delete', label: 'Delete', onSelect: () => {}, icon: 'x' },
      ],
      open: true,
      onOpenChange: () => {},
      trigger: () => 'open',
      label: 'Actions',
    });
    expect(named(one(withAttr(nodes, 'role', 'menu'), 'menu'))).toBe(true);
    // Name from content: the label's text, with the icon hidden from the computation.
    expect(withAttr(nodes, 'role', 'menuitem').map((item) => spokenText(item))).toEqual([
      'Edit',
      'Delete',
    ]);
  });
});

describe('Menu: Tab closes it (APG menu button)', () => {
  const render = (seen: boolean[]): RenderNode[] =>
    renderNodes(Menu, {
      items: [{ id: 'edit', label: 'Edit', onSelect: () => {} }],
      open: true,
      onOpenChange: (open: boolean) => seen.push(open),
      trigger: () => 'open',
      label: 'Actions',
    });

  for (const shift of [false, true]) {
    test(`${shift ? 'Shift+Tab' : 'Tab'} closes the menu and leaves the move to the browser`, () => {
      const seen: boolean[] = [];
      const panel = one(withAttr(render(seen), 'role', 'menu'), 'role="menu"');
      const list = new FakeElement('div', { role: 'menu' });
      const item = new FakeElement('button', { role: 'menuitem', tabindex: '0' });
      list.append(item);
      const dom = installFakeDom(list);
      try {
        attachRef(panel, list);
        item.focus();
        const event = keydown('Tab', shift);
        fire(panel, 'onKeyDown', event);
        expect(seen).toEqual([false]);
        // Not prevented: the trap releases focus to the trigger, and Tab moves on from there.
        expect(event.defaultPrevented).toBe(false);
      } finally {
        dom.restore();
      }
    });
  }

  test('an arrow key never closes it', () => {
    const seen: boolean[] = [];
    const panel = one(withAttr(render(seen), 'role', 'menu'), 'role="menu"');
    const list = new FakeElement('div', { role: 'menu' });
    const item = new FakeElement('button', { role: 'menuitem', tabindex: '0' });
    list.append(item);
    const dom = installFakeDom(list);
    try {
      attachRef(panel, list);
      item.focus();
      fire(panel, 'onKeyDown', keydown('ArrowDown'));
      expect(seen).toEqual([]);
    } finally {
      dom.restore();
    }
  });
});
