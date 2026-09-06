// The micro-DOM's LAYOUT contract — the box, the scroll offset and `ResizeObserver` — split from
// `island-dom.test.ts` at the 500-line ceiling and driven the same way: through `mountIsland`, by
// an island written in the compiled idiom, never by poking the double.

import { describe, expect, test } from 'bun:test';
import type { IslandBuilder } from './fixture-island';
import { mountIsland } from './fixture-island';
import { testName } from './test-types';

const FILE = 'apps/web/site/counter.island.tsx';
const ROOT = '/tmp/island-dom-root';

const builderOf = (chunks: readonly { file: string; code: string }[]): IslandBuilder => {
  return (root: string) => Promise.resolve({ chunks: root === ROOT ? chunks : [] });
};

const mount = (code: string, props: unknown, extra: Record<string, unknown> = {}) =>
  mountIsland({
    build: builderOf([{ file: FILE, code }]),
    root: ROOT,
    file: FILE,
    props,
    ...extra,
  });

describe(
  testName('unit', 'a virtualized list: the box, the scroll offset and ResizeObserver'),
  () => {
    // The three things a windowed list reads and a stub without them cannot run: `clientHeight` for
    // how many rows fit, `scrollTop` in a `scroll` listener for which row is first, and a
    // `ResizeObserver` for when the first number changes. Written in the compiled idiom — a row
    // template cloned per visible item, a listener for the one event Solid does not delegate — so
    // this file states what the micro-DOM must answer rather than inheriting it from a bundler.
    const VIRTUAL_LIST = `const _row$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<li> </li>';
  return t.content.firstChild;
})();

export function mount(el, props) {
  el.textContent = '';
  el.setAttribute('data-host-height', String(el.clientHeight));
  const scroller = document.createElement('div');
  scroller.setAttribute('data-role', 'scroller');
  const list = document.createElement('ul');
  scroller.appendChild(list);
  el.appendChild(scroller);

  let height = scroller.clientHeight;
  const paint = () => {
    const first = Math.floor(scroller.scrollTop / props.rowHeight);
    const count = Math.ceil(height / props.rowHeight);
    list.textContent = '';
    for (const label of props.items.slice(first, first + count)) {
      const row = document.importNode(_row$, true);
      row.firstChild.data = label;
      list.appendChild(row);
    }
    el.setAttribute('data-window', first + ':' + count);
  };
  const observer = new ResizeObserver((entries, self) => {
    const entry = entries[0];
    el.setAttribute('data-entry', [
      entry.target === scroller, self === observer, entry.contentRect.width, entry.contentRect.height,
      entry.borderBoxSize[0].blockSize, scroller.getBoundingClientRect().height,
    ].join('|'));
    height = entry.contentRect.height;
    paint();
  });
  observer.observe(scroller);
  scroller.addEventListener('scroll', paint);
  scroller.addEventListener('x-jump', () => scroller.scrollTo(0, 3 * props.rowHeight));
  scroller.addEventListener('x-unmount', () => observer.disconnect());
  paint();
}
`;

    const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'];
    const SCROLLER = '[data-role="scroller"]';
    const mountList = (extra: Record<string, unknown> = {}) =>
      mount(VIRTUAL_LIST, { items: ITEMS, rowHeight: 40 }, extra);
    const rows = (island: { all: (sel: string) => readonly { textContent: string }[] }): string[] =>
      island.all(`${SCROLLER} > ul > li`).map((row) => row.textContent);

    test('every box field is 0 until a test writes it, so an unmeasured list renders no rows', async () => {
      using island = await mountList();
      // Not `undefined`: `Math.ceil(undefined / 40)` is `NaN`, and `slice(0, NaN)` is an empty list
      // with no error anywhere near the cause.
      expect(island.el.getAttribute('data-window')).toBe('0:0');
      expect(rows(island)).toEqual([]);
      const scroller = island.find(SCROLLER);
      expect(scroller?.clientHeight).toBe(0);
      expect(scroller?.scrollTop).toBe(0);
      expect(scroller?.scrollHeight).toBe(0);
      expect(scroller?.getBoundingClientRect()).toEqual({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
      });
    });

    test('resize writes the box and delivers a spec-shaped entry to the observer of that element', async () => {
      using island = await mountList();
      expect(island.resize(SCROLLER, { height: 100, width: 300 })).toBe(true);
      expect(island.el.getAttribute('data-entry')).toBe('true|true|300|100|100|100');
      // 100px over 40px rows is three rows, the third clipped — `ceil`, as a list that must cover
      // the window computes it.
      expect(island.el.getAttribute('data-window')).toBe('0:3');
      expect(rows(island)).toEqual(['a', 'b', 'c']);
      expect(island.find(SCROLLER)?.clientHeight).toBe(100);
      expect(island.find(SCROLLER)?.offsetWidth).toBe(300);
    });

    test('one axis alone leaves the other where it was', async () => {
      using island = await mountList();
      island.resize(SCROLLER, { height: 100, width: 300 });
      island.resize(SCROLLER, { height: 80 });
      expect(island.el.getAttribute('data-entry')).toBe('true|true|300|80|80|80');
      expect(rows(island)).toEqual(['a', 'b']);
    });

    test('scroll moves scrollTop and runs the scroll listener, so the window advances', async () => {
      using island = await mountList();
      island.resize(SCROLLER, { height: 100 });
      expect(island.scroll(SCROLLER, { top: 80 })).toBe(true);
      expect(island.find(SCROLLER)?.scrollTop).toBe(80);
      expect(island.el.getAttribute('data-window')).toBe('2:3');
      expect(rows(island)).toEqual(['c', 'd', 'e']);
    });

    test('the island scrolling itself — scrollTo(left, top) — is the same path', async () => {
      using island = await mountList();
      island.resize(SCROLLER, { height: 80 });
      expect(island.fire(SCROLLER, 'x-jump')).toBe(true);
      expect(island.find(SCROLLER)?.scrollTop).toBe(120);
      expect(rows(island)).toEqual(['d', 'e']);
    });

    test('an element nothing observes is resized and answers false', async () => {
      using island = await mountList();
      // `false` for `fire`'s reason: the list never called `observe` on the `<ul>`, and a test that
      // resized it expecting rows would otherwise have no way to tell that from a list that ignored
      // the entry.
      expect(island.resize(`${SCROLLER} > ul`, { height: 500 })).toBe(false);
      expect(island.find(`${SCROLLER} > ul`)?.clientHeight).toBe(500);
      expect(island.el.getAttribute('data-window')).toBe('0:0');
      expect(island.scroll(`${SCROLLER} > ul`, { top: 10 })).toBe(false);
      expect(island.resize('[data-role="absent"]', { height: 1 })).toBe(false);
      expect(island.observing('[data-role="absent"]')).toBe(false);
    });

    test('a disconnected observer hears nothing more, and observing() says so', async () => {
      using island = await mountList();
      expect(island.observing(SCROLLER)).toBe(true);
      expect(island.fire(SCROLLER, 'x-unmount')).toBe(true);
      expect(island.observing(SCROLLER)).toBe(false);
      // The box is still written — the element still has a size — but no callback ran, which is
      // the assertion a teardown test makes: an `onCleanup` that forgot `disconnect()` answers
      // `true` here.
      expect(island.resize(SCROLLER, { height: 100 })).toBe(false);
      expect(island.el.getAttribute('data-entry')).toBeNull();
      expect(island.find(SCROLLER)?.clientHeight).toBe(100);
    });

    test('size: lays out the host before mount, the one element that exists then', async () => {
      using island = await mountList({ size: { height: 640, width: 480 } });
      expect(island.el.getAttribute('data-host-height')).toBe('640');
      expect(island.el.clientWidth).toBe(480);
    });

    test('ResizeObserver is a constructor while mounted and gone after dispose', async () => {
      const island = await mountList();
      expect(typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBe('function');
      island[Symbol.dispose]();
      expect('ResizeObserver' in globalThis).toBe(false);
    });
  },
);
