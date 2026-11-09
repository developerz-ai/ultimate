// Small controls' island halves, each driven the way a browser would: `?` toggles the shortcut
// legend only where there is a keyboard; the copy button says "copied" only on a write that
// resolved, and stops saying it on its timer; the combobox's filter waits out its window unless
// a suggestion was PICKED; a link tab strip scrolls its current tab into view.

import '../theme/ambient';
import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import {
  attachRef,
  byComponent,
  byTag,
  fire,
  nodesOf,
  one,
  renderNodes,
} from '@ultimat3/core/render-nodes';
import {
  browserSolid,
  fakeMatchMedia,
  installGlobals,
  runtimeOf,
  type Solid,
  syncRuntime,
} from '../browser-fake-fixture';
import { FakeElement, type InstalledDom, installFakeDom } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Combobox } from './Combobox';
import { COPIED_MS, CopyButton } from './CopyButton';
import { ShortcutSheet } from './ShortcutSheet';
import { Tabs } from './Tabs';

let dom: InstalledDom | undefined;
let restore: (() => void) | undefined;
let unmount = (): void => {};
afterEach(() => {
  unmount();
  unmount = () => {};
  restore?.();
  restore = undefined;
  dom?.restore();
  dom = undefined;
  clearSolidRuntime();
  jest.useRealTimers();
});

const runtime = () => {
  const rt = syncRuntime();
  unmount = rt.unmount;
  setSolidRuntime(rt.runtime);
  return rt;
};

const question = () => ({
  key: '?',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  target: null,
  timeStamp: 0,
  preventDefault: () => {},
});

describe('ShortcutSheet', () => {
  test('? opens and closes the legend; the dialog’s close shuts it', () => {
    dom = installFakeDom(new FakeElement('div'));
    const rt = runtime();
    const nodes = renderNodes(ShortcutSheet, {}, { components: 'keep' });
    // ShortcutSheet's first signal: open.
    const open = rt.signals[0];
    expect(open?.()).toBe(false);
    dom.document.dispatch('keydown', question());
    expect(open?.()).toBe(true);
    dom.document.dispatch('keydown', question());
    expect(open?.()).toBe(false);
    dom.document.dispatch('keydown', question());
    const dialog = one(byComponent(nodes, 'Dialog'), '<Dialog>');
    (dialog.props['onClose'] as () => void)();
    expect(open?.()).toBe(false);
  });

  test('a touch-only device never opens it', () => {
    dom = installFakeDom(new FakeElement('div'));
    restore = installGlobals({ matchMedia: fakeMatchMedia(new Map([['(hover: none)', true]])) });
    const rt = runtime();
    renderNodes(ShortcutSheet, { title: 'Keys' });
    dom.document.dispatch('keydown', question());
    expect(rt.signals[0]?.()).toBe(false);
  });
});

describe('CopyButton', () => {
  const clipboard = (ok: boolean) => {
    const written: string[] = [];
    return {
      written,
      writeText: (value: string) => {
        written.push(value);
        return ok ? Promise.resolve() : Promise.reject(new Error('denied'));
      },
    };
  };

  test('a resolved write says copied, and the timer takes it back', async () => {
    jest.useFakeTimers();
    const board = clipboard(true);
    restore = installGlobals({ navigator: { clipboard: board } });
    const rt = runtime();
    const nodes = renderNodes(CopyButton, { value: 'secret-id' });
    fire(one(byTag(nodes, 'button'), '<button>'), 'onClick', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(board.written).toEqual(['secret-id']);
    expect(rt.signals[0]?.()).toBe(true);
    jest.advanceTimersByTime(COPIED_MS - 1);
    expect(rt.signals[0]?.()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(rt.signals[0]?.()).toBe(false);
  });

  test('a refused write never says copied; unmount drops a pending reset', async () => {
    jest.useFakeTimers();
    restore = installGlobals({ navigator: { clipboard: clipboard(false) } });
    const refused = runtime();
    fire(one(byTag(renderNodes(CopyButton, { value: 'x' }), 'button'), 'b'), 'onClick', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(refused.signals[0]?.()).toBe(false);

    restore();
    restore = installGlobals({ navigator: { clipboard: clipboard(true) } });
    const ok = runtime();
    fire(one(byTag(renderNodes(CopyButton, { value: 'x' }), 'button'), 'b'), 'onClick', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(ok.signals[0]?.()).toBe(true);
    ok.unmount();
    jest.advanceTimersByTime(COPIED_MS);
    expect(ok.signals[0]?.()).toBe(true);
  });
});

describe('Combobox filter', () => {
  const turn = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  };
  const mount = () => {
    runtime();
    const filtered: string[] = [];
    const nodes = renderNodes(Combobox, {
      options: [{ value: 'Berlin' }, { value: 'Bern' }],
      debounceMs: 0,
      onFilter: (query: string) => filtered.push(query),
      'aria-label': 'City',
    });
    return { input: one(byTag(nodes, 'input'), '<input>'), filtered };
  };

  test('typing reaches onFilter after its window; a picked suggestion at once, the typing dropped', async () => {
    const { input, filtered } = mount();
    fire(input, 'onInput', { currentTarget: { value: 'Ber' } });
    expect(filtered).toEqual([]);
    await turn();
    expect(filtered).toEqual(['Ber']);
    fire(input, 'onInput', { currentTarget: { value: 'Berl' } });
    fire(input, 'onChange', { currentTarget: { value: 'Berlin' } });
    expect(filtered).toEqual(['Ber', 'Berlin']);
    await turn();
    expect(filtered).toEqual(['Ber', 'Berlin']);
  });

  test('unmounting cancels a filter still waiting', async () => {
    const { input, filtered } = mount();
    fire(input, 'onInput', { currentTarget: { value: 'B' } });
    unmount();
    await turn();
    expect(filtered).toEqual([]);
  });
});

describe('Tabs as links, under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });

  const items = [
    { id: 'all', label: 'All' },
    { id: 'mine', label: 'Mine' },
  ];

  test('the current tab is scrolled into view, nearest on both axes; the others are not', () => {
    setSolidRuntime(runtimeOf(solid));
    const scrolled: unknown[] = [];
    let dispose = (): void => {};
    solid.createRoot((done) => {
      dispose = done;
      const nodes = nodesOf(
        Tabs({ items, value: 'all', label: 'Filter', hrefFor: (id: string) => `/runs?f=${id}` }),
      );
      const [all, mine] = byTag(nodes, 'a');
      if (all === undefined || mine === undefined) return expect.unreachable('two tab links');
      attachRef(all, { scrollIntoView: (options: unknown) => scrolled.push(options) });
      attachRef(mine, { scrollIntoView: () => scrolled.push('mine') });
      expect(all.props['href']).toBe('/runs?f=all');
      expect(all.props['aria-current']).toBe('page');
      expect(mine.props['aria-current']).toBeUndefined();
    });
    expect(scrolled).toEqual([{ block: 'nearest', inline: 'nearest' }]);
    dispose();
  });

  test('a current tab with no scrollIntoView, and an href that is not a string, are handled', () => {
    setSolidRuntime(runtimeOf(solid));
    let dispose = (): void => {};
    solid.createRoot((done) => {
      dispose = done;
      const nodes = nodesOf(Tabs({ items, value: 'all', label: 'F', hrefFor: (id: string) => id }));
      attachRef(one(byTag(nodes, 'a').slice(0, 1), 'first'), {});
    });
    dispose();
    clearSolidRuntime();
    expect(() => renderNodes(Tabs, { items, value: 'all', label: 'F', hrefFor: () => 42 })).toThrow(
      /Tabs hrefFor/,
    );
  });
});
