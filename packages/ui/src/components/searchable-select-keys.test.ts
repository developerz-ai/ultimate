// The SearchableSelect controller with no DOM and no renderer: plain state, a local-ranking view
// exactly as the component builds one without `onSearch`, and literal key events.

import { describe, expect, test } from 'bun:test';
import type { SearchableKey } from './searchable-select-keys';
import { searchableKeys } from './searchable-select-keys';
import type { SearchableOption } from './searchable-select-view';
import { searchableView } from './searchable-select-view';

const FRUIT: readonly SearchableOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry' },
];

function controller(multiple: boolean, options: readonly SearchableOption[] = FRUIT, limit = 50) {
  let chosen: readonly string[] = [];
  let open = false;
  let active = -1;
  let query: string | null = null;
  const view = () => searchableView(options, query ?? '', limit);
  const keys = searchableKeys({
    view,
    chosen: () => chosen,
    multiple: () => multiple,
    open: () => open,
    active: () => active,
    query: () => query,
    setOpen: (next) => {
      open = next;
    },
    setActive: (next) => {
      active = next;
    },
    setQuery: (next) => {
      query = next;
    },
    commit: (next) => {
      chosen = next;
    },
  });
  const press = (key: string): void => {
    const event: SearchableKey = { key, preventDefault: () => undefined };
    keys.onKeyDown(event);
  };
  const activeValue = (): string | undefined => view().rows[active]?.option.value;
  return {
    keys,
    press,
    activeValue,
    chosen: () => chosen,
    open: () => open,
    query: () => query,
  };
}

describe('searchableKeys, multiple, picking from a filtered list', () => {
  test('the picked option stays active once the query clears — a second Enter unticks it', () => {
    const select = controller(true);
    select.keys.typed('ban');
    expect(select.activeValue()).toBe('b');
    select.press('Enter');
    expect(select.chosen()).toEqual(['b']);
    expect(select.query()).toBeNull();
    // The unfiltered list puts Apple at Banana's old index; the highlight must not land on it.
    expect(select.activeValue()).toBe('b');
    select.press('Enter');
    expect(select.chosen()).toEqual([]);
  });

  test('a click on a filtered row keeps that row active too', () => {
    const select = controller(true);
    select.keys.typed('cher');
    select.keys.pickRow(0);
    expect(select.chosen()).toEqual(['c']);
    expect(select.activeValue()).toBe('c');
    expect(select.open()).toBe(true);
  });

  test('when the picked option is not in the new view, the first enabled row is active', () => {
    // A one-row view: once the query clears, only the first enabled match is drawn.
    const select = controller(true, [{ value: 'x', label: 'Xylo', disabled: true }, ...FRUIT], 2);
    select.keys.typed('cher');
    select.press('Enter');
    expect(select.chosen()).toEqual(['c']);
    expect(select.activeValue()).toBe('a');
  });
});

describe('searchableKeys, single', () => {
  test('Enter picks the active row and closes the list', () => {
    const select = controller(false);
    select.press('ArrowDown');
    expect(select.open()).toBe(true);
    expect(select.activeValue()).toBe('a');
    select.press('ArrowDown');
    select.press('Enter');
    expect(select.chosen()).toEqual(['b']);
    expect(select.open()).toBe(false);
    expect(select.query()).toBeNull();
  });

  test('a disabled row is never picked', () => {
    const select = controller(false, [{ value: 'x', label: 'Xylo', disabled: true }, ...FRUIT]);
    select.keys.toggle();
    select.keys.pickRow(0);
    expect(select.chosen()).toEqual([]);
  });

  test('Escape and Tab close without picking; Backspace on an empty multi query drops a chip', () => {
    const select = controller(false);
    select.keys.typed('ap');
    select.press('Escape');
    expect(select.open()).toBe(false);
    expect(select.query()).toBeNull();
    const many = controller(true);
    many.keys.typed('ap');
    many.press('Enter');
    many.press('Backspace');
    expect(many.chosen()).toEqual([]);
    many.press('Tab');
    expect(many.open()).toBe(false);
  });
});
