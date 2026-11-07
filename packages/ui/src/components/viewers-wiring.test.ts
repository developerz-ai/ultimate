// What the viewers' controls DO once script runs, read off a re-walk of the same tree after a
// handler fired: the log's filter, level floor and follow toggle; the terminal's Home/End; the
// code block's wrap toggle; the diff's "next change" cycling the VISIBLE table only; and every
// leaf a JSON value can print as. `viewers.test.ts` holds what they render with script off.

import '../theme/ambient';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  attachRef,
  byComponent,
  byTag,
  fire,
  nodesOf,
  one,
  type RenderNode,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { syncRuntime } from '../browser-fake-fixture';
import { keydown } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { CodeBlock } from './CodeBlock';
import { DiffView } from './DiffView';
import { JsonView } from './JsonView';
import { LogViewer } from './LogViewer';
import { TerminalView } from './TerminalView';

afterEach(clearSolidRuntime);

/**
 * Render once under a runtime that records what the render created. The server factory freezes an
 * attribute at render time, so what a handler changed is read where the component keeps it: the
 * memo its list is drawn from, the signal its toggle flips — in the order the component made them.
 */
const live = (component: (props: never) => unknown, props: Record<string, unknown>) => {
  const rt = syncRuntime();
  setSolidRuntime(rt.runtime);
  const output = component(props as never);
  const memos = [...rt.memos];
  const signals = [...rt.signals];
  return { nodes: (): RenderNode[] => nodesOf(output), memos, signals };
};

const shownIds = (memo: (() => unknown) | undefined): unknown[] => {
  if (memo === undefined) return expect.unreachable('LogViewer created no memo');
  return (memo() as { lines: readonly { id: string }[] }).lines.map((line) => line.id);
};

const LINES = [
  { id: '1', text: 'boot', level: 'debug' },
  { id: '2', text: 'listening', level: 'info', at: new Date('2026-01-01T10:00:00Z') },
  { id: '3', text: 'slow query', level: 'warn', href: '/queries/3' },
  { id: '4', text: 'crash', level: 'error' },
] as const;

const rowTexts = (nodes: readonly RenderNode[]): unknown[] =>
  byTag(nodes, 'li').map((li) => li.props['data-key']);

describe('LogViewer controls', () => {
  test('the filter narrows by text; the level select sets a floor, and "all" clears it', () => {
    const view = live(LogViewer, { lines: LINES });
    const [shown] = view.memos;
    expect(rowTexts(view.nodes())).toEqual(['1', '2', '3', '4']);
    const input = one(byTag(view.nodes(), 'input'), 'filter');
    fire(input, 'onInput', { currentTarget: { value: 'crash' } });
    expect(shownIds(shown)).toEqual(['4']);
    fire(input, 'onInput', { currentTarget: { value: '' } });
    const select = one(byTag(view.nodes(), 'select'), '<select>');
    fire(select, 'onChange', { currentTarget: { value: 'warn' } });
    expect(shownIds(shown)).toEqual(['3', '4']);
    fire(select, 'onChange', { currentTarget: { value: '' } });
    expect(shownIds(shown)).toEqual(['1', '2', '3', '4']);
  });

  test('follow starts on unless told otherwise, and the toggle flips it', () => {
    // LogViewer's signals, in order: enhanced, query, minimum, follow.
    const view = live(LogViewer, { lines: LINES });
    const follow = view.signals[3];
    const button = one(withAttr(byTag(view.nodes(), 'button'), 'aria-pressed'), 'follow');
    expect(button.props['aria-pressed']).toBe('true');
    expect(follow?.()).toBe(true);
    fire(button, 'onClick', {});
    expect(follow?.()).toBe(false);
    fire(button, 'onClick', {});
    expect(follow?.()).toBe(true);
    expect(view.signals[0]?.()).toBe(true);
    const off = live(LogViewer, { lines: LINES, follow: false });
    expect(
      one(withAttr(byTag(off.nodes(), 'button'), 'aria-pressed'), 'follow').props['aria-pressed'],
    ).toBe('false');
  });

  test('a timed line carries a <time>, a linked line a link, and a capped log says so', () => {
    const nodes = renderNodes(LogViewer, { lines: LINES, label: 'Deploy log' });
    expect(byTag(nodes, 'time')).toHaveLength(1);
    expect(one(byTag(nodes, 'a'), '<a>').props['href']).toBe('/queries/3');
    expect(one(byTag(nodes, 'section'), 'section').props['aria-label']).toBe('Deploy log');
    const capped = renderNodes(LogViewer, { lines: LINES, cap: 2 });
    expect(byTag(capped, 'li')).toHaveLength(2);
    expect(byTag(capped, 'p')).toHaveLength(1);
    expect(byTag(nodes, 'p')).toHaveLength(0);
  });
});

describe('TerminalView keys', () => {
  const region = (rows?: number) => {
    const nodes = renderNodes(TerminalView, { text: 'a\nb', ...(rows ? { rows } : {}) });
    return one(withAttr(nodes, 'role', 'region'), 'region');
  };
  const boxed = () => {
    const node = region();
    const box = { scrollTop: 50, scrollHeight: 900 };
    attachRef(node, {
      querySelector: (sel: string) => (sel === 'ul' ? { parentElement: box } : null),
    });
    return { node, box };
  };

  test('Home goes to the top and End to the bottom of the list box, refusing the page scroll', () => {
    const { node, box } = boxed();
    const end = keydown('End');
    fire(node, 'onKeyDown', end);
    expect(box.scrollTop).toBe(900);
    expect(end.defaultPrevented).toBe(true);
    fire(node, 'onKeyDown', keydown('Home'));
    expect(box.scrollTop).toBe(0);
  });

  test('another key, or no list yet, is left alone', () => {
    const { node, box } = boxed();
    const other = keydown('ArrowDown');
    fire(node, 'onKeyDown', other);
    expect(other.defaultPrevented).toBe(false);
    expect(box.scrollTop).toBe(50);
    const empty = region();
    attachRef(empty, { querySelector: () => null });
    const home = keydown('Home');
    fire(empty, 'onKeyDown', home);
    expect(home.defaultPrevented).toBe(false);
  });

  test('rows sets the height in lines, 24 by default', () => {
    expect((region().props['style'] as Record<string, string>)['--terminal-rows']).toBe('24');
    expect((region(10).props['style'] as Record<string, string>)['--terminal-rows']).toBe('10');
  });
});

describe('CodeBlock', () => {
  test('the wrap toggle flips the block and its pressed state; copy=false drops the copy button', () => {
    // CodeBlock's signals, in order: enhanced, wrapped.
    const view = live(CodeBlock, { code: 'const a = 1;' });
    const wrapped = view.signals[1];
    const toggle = one(withAttr(byTag(view.nodes(), 'button'), 'aria-pressed'), 'wrap');
    expect(toggle.props['aria-pressed']).toBe('false');
    expect(view.nodes()[0]?.props['data-wrap']).toBeUndefined();
    expect(view.nodes()[0]?.props['data-enhanced']).toBe('true');
    fire(toggle, 'onClick', {});
    expect(wrapped?.()).toBe(true);
    fire(toggle, 'onClick', {});
    expect(wrapped?.()).toBe(false);
    expect(byTag(view.nodes(), 'button')).toHaveLength(2);
    clearSolidRuntime();
    const bare = renderNodes(CodeBlock, { code: 'x', copy: false, wrap: true });
    expect(byTag(bare, 'button')).toHaveLength(1);
    expect(bare[0]?.props['data-wrap']).toBe('true');
    expect(
      byComponent(renderNodes(CodeBlock, { code: 'x' }, { components: 'keep' }), 'CopyButton'),
    ).toHaveLength(1);
  });
});

describe('DiffView next change', () => {
  /** A table: visible or not, holding these change starts. */
  const table = (visible: boolean, starts: string[]) => ({
    offsetParent: visible ? {} : null,
    querySelectorAll: () => starts.map((name) => ({ scrollIntoView: () => scrolled.push(name) })),
  });
  let scrolled: string[] = [];

  test('cycles the starts of the visible table, wrapping, and never the hidden one', () => {
    scrolled = [];
    const nodes = renderNodes(DiffView, { old: 'a\nb\nc', new: 'x\nb\ny' });
    attachRef(one(withAttr(nodes, 'role', 'region'), 'region'), {
      querySelectorAll: () => [table(false, ['hidden']), table(true, ['one', 'two'])],
    });
    const next = one(byTag(nodes, 'button'), 'next');
    for (let i = 0; i < 3; i += 1) fire(next, 'onClick', {});
    expect(scrolled).toEqual(['one', 'two', 'one']);
  });

  test('no starts, or no box, scrolls nothing', () => {
    scrolled = [];
    const nodes = renderNodes(DiffView, { old: 'a', new: 'a' });
    fire(one(byTag(nodes, 'button'), 'next'), 'onClick', {});
    attachRef(one(withAttr(nodes, 'role', 'region'), 'region'), {
      querySelectorAll: () => [table(true, [])],
    });
    fire(one(byTag(nodes, 'button'), 'next'), 'onClick', {});
    expect(scrolled).toEqual([]);
  });

  test('a unified patch renders the same changes, each start marked once per table', () => {
    const nodes = renderNodes(DiffView, {
      patch: '@@ -1,3 +1,3 @@\n-a\n+x\n b\n-c\n+y\n',
    });
    expect(withAttr(nodes, 'data-change', 'start')).toHaveLength(4);
  });
});

describe('JsonView leaves', () => {
  test('strings are quoted, a cycle is ↺, past the depth limit is …, and nulls print', () => {
    const cyclic: Record<string, unknown> = { name: 'ann', none: null };
    cyclic['self'] = cyclic;
    let deep: unknown = 'bottom';
    for (let i = 0; i < 20; i += 1) deep = [deep];
    const nodes = renderNodes(JsonView, { value: { cyclic, deep }, label: 'v', open: 0 });
    const leaves = byTag(nodes, 'span')
      .filter((span) => typeof span.props['children'] === 'string')
      .map((span) => span.props['children']);
    expect(leaves).toContain('"ann"');
    expect(leaves).toContain('null');
    expect(leaves).toContain('↺');
    expect(leaves).toContain('…');
    expect(byTag(nodes, 'details').every((d) => d.props['open'] === false)).toBe(true);
  });
});
