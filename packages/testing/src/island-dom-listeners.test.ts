// The micro-DOM keeps EVERY listener of a type, and removes one by identity — as the DOM does.
// It kept one per type and `removeEventListener` ignored the function, so `@ultimat3/ui`'s Menu,
// which closes on an Escape registered on `document`, lost that listener to its own focus trap's
// keydown: the Menu could be mounted and never shut. Driven through `mountIsland`, as
// `island-dom.test.ts` drives the rest of the double.

import { describe, expect, test } from 'bun:test';
import { mountIsland } from './fixture-island';
import { builderOf, FILE, ROOT } from './fixture-island-fixtures.test';
import { testName } from './test-types';

/** Two `document` keydown listeners — a menu's Escape and a focus trap's Tab — like Menu's. */
const MENU_ISLAND = `export function mount(el) {
  el.textContent = 'open';
  const escape = (event) => { if (event.key === 'Escape') el.dataset.menu = 'closed'; };
  const trap = (event) => { if (event.key === 'Tab') el.dataset.trap = 'held'; };
  document.addEventListener('keydown', escape);
  document.addEventListener('keydown', trap);
  // A different function that merely LOOKS like the trap: removing it removes nothing.
  document.removeEventListener('keydown', (event) => trap(event));
  el.dropTrap = () => document.removeEventListener('keydown', trap);
}
`;

const mountMenu = () =>
  mountIsland({ build: builderOf([{ file: FILE, code: MENU_ISLAND }]), root: ROOT, file: FILE });

describe(testName('unit', 'every listener of a type runs, and removal is by identity'), () => {
  test('two keydown listeners on document both hear one event', async () => {
    using mounted = await mountMenu();
    expect(mounted.fire(mounted.documentElement, 'keydown', { key: 'Escape' })).toBe(true);
    expect(mounted.fire(mounted.documentElement, 'keydown', { key: 'Tab' })).toBe(true);
    expect(mounted.el.dataset['menu']).toBe('closed');
    expect(mounted.el.dataset['trap']).toBe('held');
  });

  test('removing one listener leaves the other, and removing the last leaves none', async () => {
    using mounted = await mountMenu();
    (mounted.el as unknown as { dropTrap: () => void }).dropTrap();
    expect(mounted.fire(mounted.documentElement, 'keydown', { key: 'Tab' })).toBe(true);
    expect(mounted.el.dataset['trap']).toBeUndefined();
    expect(mounted.fire(mounted.documentElement, 'keydown', { key: 'Escape' })).toBe(true);
    expect(mounted.el.dataset['menu']).toBe('closed');
  });

  test('the same function added twice runs once, as the DOM dedupes it', async () => {
    const code = `export function mount(el) {
  let n = 0;
  const count = () => { n += 1; el.textContent = String(n); };
  el.addEventListener('scroll', count);
  el.addEventListener('scroll', count);
}
`;
    using mounted = await mountIsland({
      build: builderOf([{ file: FILE, code }]),
      root: ROOT,
      file: FILE,
    });
    expect(mounted.scroll(mounted.el, { top: 10 })).toBe(true);
    expect(mounted.el.textContent).toBe('1');
  });

  // The DOM's dispatch rule: a listener removed before its turn does not run, and one removed and
  // added again is a NEW registration the running dispatch never saw — it runs from the next one.
  test('a listener removed by an earlier one in the same dispatch does not run; re-added, it waits', async () => {
    const code = `export function mount(el) {
  const log = [];
  el.dataset.log = '';
  const second = () => { log.push('second'); el.dataset.log = log.join(','); };
  const first = (event) => {
    log.push('first');
    if (event.key !== 'z') el.removeEventListener('keydown', second);
    if (event.key === 'r') el.addEventListener('keydown', second);
    el.dataset.log = log.join(',');
  };
  el.addEventListener('keydown', first);
  el.addEventListener('keydown', second);
}
`;
    using mounted = await mountIsland({
      build: builderOf([{ file: FILE, code }]),
      root: ROOT,
      file: FILE,
    });
    expect(mounted.fire(mounted.el, 'keydown', { key: 'x' })).toBe(true);
    expect(mounted.el.dataset['log']).toBe('first');
    // Re-adding `second` in place: skipped in THIS dispatch, then heard by the next.
    expect(mounted.fire(mounted.el, 'keydown', { key: 'r' })).toBe(true);
    expect(mounted.el.dataset['log']).toBe('first,first');
    expect(mounted.fire(mounted.el, 'keydown', { key: 'z' })).toBe(true);
    expect(mounted.el.dataset['log']).toBe('first,first,first,second');
  });
});
