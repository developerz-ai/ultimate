// The palette shell's state, driven as its island drives it: ⌘K / Ctrl K from the page's one hotkey
// table toggles it, arrows rove, Enter runs and closes FIRST, Escape closes and hands focus back to
// the opener, and `onQuery` answers replace the list — a stale or failed answer never lands.

import '../theme/ambient';
import { afterEach, describe, expect, test } from 'bun:test';
import { syncRuntime } from '../browser-fake-fixture';
import { FakeElement, type InstalledDom, installFakeDom, keydown } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import type { CommandPaletteItem } from './command-palette-view';
import { type UseCommandPaletteOptions, useCommandPalette } from './use-command-palette';

const ITEMS: readonly CommandPaletteItem[] = [
  { id: 'home', label: 'Home', hint: '/' },
  { id: 'runs', label: 'Runs', hint: '/runs' },
  { id: 'settings', label: 'Settings', hint: '/settings' },
];

let dom: InstalledDom | undefined;
let unmount = (): void => {};
afterEach(() => {
  unmount();
  dom?.restore();
  dom = undefined;
  clearSolidRuntime();
});

const mount = (options: Partial<UseCommandPaletteOptions> = {}) => {
  const root = new FakeElement('div');
  const opener = new FakeElement('button');
  root.append(opener);
  dom = installFakeDom(root);
  const rt = syncRuntime();
  unmount = rt.unmount;
  setSolidRuntime(rt.runtime);
  const ran: string[] = [];
  const palette = useCommandPalette({
    items: ITEMS,
    label: 'Go to',
    onRun: (item) => ran.push(`${item.id}:${String(palette.props.open)}`),
    ...options,
  });
  return { palette, opener, ran, dom };
};

/** The chord `mod+k` is on this platform. */
const modK = () => {
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const event = {
    key: 'k',
    ctrlKey: !mac,
    metaKey: mac,
    altKey: false,
    isComposing: false,
    target: null,
    timeStamp: 0,
    preventDefault: () => {},
  };
  return event;
};

/** One timer turn: `debounceMs: 0` fires on the next one. */
const turn = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await Promise.resolve();
};

describe('useCommandPalette', () => {
  test('mod+k opens it from the page table, and again closes it, focus back on the opener', () => {
    const { palette, opener, dom } = mount();
    opener.focus();
    const focusedBefore = opener.focusCount;
    dom.document.dispatch('keydown', modK());
    expect(palette.props.open).toBe(true);
    expect(palette.props.query).toBe('');
    dom.document.dispatch('keydown', modK());
    expect(palette.props.open).toBe(false);
    expect(opener.focusCount).toBe(focusedBefore + 1);
  });

  test('show twice keeps the first opener; hide while closed focuses nothing', () => {
    const { palette, opener } = mount();
    palette.hide();
    expect(opener.focusCount).toBe(0);
    opener.focus();
    palette.show();
    // Focus moves into the palette's own field; a second show must not take it for the opener.
    const field = new FakeElement('input');
    opener.parent?.append(field);
    field.focus();
    palette.show();
    palette.hide();
    palette.hide();
    expect(opener.focusCount).toBe(2);
    expect(field.focusCount).toBe(1);
  });

  test('typing filters; arrows rove and wrap; Enter runs the active item after closing', () => {
    const { palette, ran } = mount();
    palette.show();
    expect(palette.props.activeId).toBe('home');
    palette.props.onFilterKeyDown(keydown('ArrowUp') as never);
    expect(palette.props.activeId).toBe('settings');
    palette.props.onQueryInput('s');
    expect(palette.props.items.map((item) => item.id)).toEqual(['settings', 'runs']);
    expect(palette.props.activeId).toBe('settings');
    const down = keydown('ArrowDown');
    palette.props.onFilterKeyDown(down as never);
    expect(down.defaultPrevented).toBe(true);
    expect(palette.props.activeId).toBe('runs');
    palette.props.onFilterKeyDown(keydown('ArrowDown') as never);
    expect(palette.props.activeId).toBe('settings');
    palette.props.onFilterKeyDown(keydown('ArrowUp') as never);
    expect(palette.props.activeId).toBe('runs');
    palette.props.onFilterKeyDown(keydown('Enter') as never);
    expect(ran).toEqual(['runs:false']);
    expect(palette.props.open).toBe(false);
  });

  test('a key it does not own is left alone; Escape closes; hover moves; a click runs by id', () => {
    const { palette, ran } = mount();
    palette.show();
    const other = keydown('a');
    palette.props.onFilterKeyDown(other as never);
    expect(other.defaultPrevented).toBe(false);
    palette.props.onHoverItem('settings');
    expect(palette.props.activeId).toBe('settings');
    palette.props.onFilterKeyDown(keydown('Escape') as never);
    expect(palette.props.open).toBe(false);
    palette.show();
    palette.props.onRunItem('missing');
    expect(palette.props.open).toBe(true);
    palette.props.onRunItem('runs');
    expect(ran).toEqual(['runs:false']);
    palette.show();
    palette.props.onClose();
    expect(palette.props.open).toBe(false);
  });

  test('items as a function are read live', () => {
    let items: readonly CommandPaletteItem[] = ITEMS.slice(0, 1);
    const { palette } = mount({ items: () => items });
    expect(palette.props.items).toHaveLength(1);
    items = ITEMS;
    expect(palette.props.items).toHaveLength(3);
  });

  test('onQuery: loading while asked, its answer replaces the list, an empty query shows items', async () => {
    const asked: string[] = [];
    const { palette } = mount({
      debounceMs: 0,
      onQuery: (query) => {
        asked.push(query);
        return Promise.resolve([{ id: `found-${query}`, label: query, hint: '' }]);
      },
    });
    palette.show();
    palette.props.onQueryInput('ru');
    expect(palette.props.loading).toBe(true);
    await turn();
    expect(asked).toEqual(['ru']);
    expect(palette.props.loading).toBe(false);
    expect(palette.props.items.map((item) => item.id)).toEqual(['found-ru']);
    palette.props.onQueryInput('  ');
    expect(palette.props.loading).toBe(false);
    expect(palette.props.items).toHaveLength(3);
  });

  test('a stale answer is dropped, a failed one empties the list, and closing drops one in flight', async () => {
    const pending: {
      query: string;
      resolve: (v: CommandPaletteItem[]) => void;
      reject: (e: unknown) => void;
    }[] = [];
    const { palette } = mount({
      debounceMs: 0,
      onQuery: (query) =>
        new Promise((resolve, reject) => {
          pending.push({ query, resolve, reject });
        }),
    });
    const answer = (index: number) => {
      const entry = pending[index];
      if (entry === undefined)
        return expect.unreachable(`onQuery was asked ${pending.length} times`);
      return entry;
    };
    palette.show();
    palette.props.onQueryInput('a');
    await turn();
    answer(0).resolve([{ id: 'first', label: 'a', hint: '' }]);
    await turn();
    expect(palette.props.items.map((item) => item.id)).toEqual(['first']);

    palette.props.onQueryInput('ab');
    await turn();
    palette.props.onQueryInput('abc');
    await turn();
    answer(2).reject(new Error('offline'));
    await turn();
    expect(palette.props.items).toEqual([]);
    expect(palette.props.loading).toBe(false);
    answer(1).resolve([{ id: 'stale', label: 'ab', hint: '' }]);
    await turn();
    expect(palette.props.items).toEqual([]);

    palette.props.onQueryInput('abcd');
    await turn();
    palette.hide();
    expect(palette.props.loading).toBe(false);
    answer(3).resolve([{ id: 'late', label: 'abcd', hint: '' }]);
    await turn();
    palette.show();
    palette.props.onQueryInput('abcd');
    expect(palette.props.items).toEqual([]);
    expect(pending.map((entry) => entry.query)).toEqual(['a', 'ab', 'abc', 'abcd']);
  });

  test('closing cancels a query still waiting on its debounce', async () => {
    const asked: string[] = [];
    const { palette } = mount({
      debounceMs: 0,
      onQuery: (query) => {
        asked.push(query);
        return Promise.resolve([]);
      },
    });
    palette.show();
    palette.props.onQueryInput('x');
    palette.hide();
    await turn();
    expect(asked).toEqual([]);
  });
});
