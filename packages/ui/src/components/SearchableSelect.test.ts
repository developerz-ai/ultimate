// The searchable select's WIRING: a server render is a real `<select name>` and no listbox; under
// a real Solid runtime the effect swaps in the combobox, keeps focus, posts the chosen value
// through hidden inputs, and never posts what was typed. `searchable-select-view.test.ts` holds
// the rules; this holds that the component hands them the right events.

import '../theme/ambient';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  attachRef,
  byTag,
  fire,
  nodesOf,
  one,
  type RenderNode,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { FakeElement, installFakeDom, keydown } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { SearchableSelect } from './SearchableSelect';
import type { SearchableOption } from './searchable-select-view';

type Solid = typeof import('solid-js');

async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

const ZONES: readonly SearchableOption[] = [
  { value: 'Europe/Berlin', label: 'Berlin', group: 'Europe' },
  { value: 'Europe/Zurich', label: 'Zürich', group: 'Europe' },
  { value: 'America/New_York', label: 'New York', group: 'America' },
];

const posted = (nodes: readonly RenderNode[]): unknown[] =>
  withAttr(byTag(nodes, 'input'), 'type', 'hidden').map((node) => [
    node.props['name'],
    node.props['value'],
  ]);

describe('SearchableSelect, server render', () => {
  test('a native select carrying the name, groups and the chosen option — no listbox', () => {
    const nodes = renderNodes(SearchableSelect, {
      name: 'tz',
      options: ZONES,
      value: 'Europe/Zurich',
    });
    const select = one(byTag(nodes, 'select'), '<select>');
    expect(select.props['name']).toBe('tz');
    expect(byTag(nodes, 'optgroup').map((node) => node.props['label'])).toEqual([
      'Europe',
      'America',
    ]);
    const selected = byTag(nodes, 'option').filter((node) => node.props['selected'] === true);
    expect(selected.map((node) => node.props['value'])).toEqual(['Europe/Zurich']);
    expect(withAttr(nodes, 'role', 'listbox')).toHaveLength(0);
    expect(withAttr(nodes, 'role', 'combobox')).toHaveLength(0);
  });

  test('a value naming no option is refused on the server too, the value named', () => {
    expect(() =>
      renderNodes(SearchableSelect, { name: 'tz', options: ZONES, value: 'Mars/Olympus' }),
    ).toThrow(/Mars\/Olympus/);
  });

  test('many values: a native multiple select', () => {
    const nodes = renderNodes(SearchableSelect, {
      name: 'tz',
      options: ZONES,
      multiple: true,
      value: ['Europe/Berlin', 'America/New_York'],
    });
    expect(one(byTag(nodes, 'select'), '<select>').props['multiple']).toBe(true);
    const selected = byTag(nodes, 'option').filter((node) => node.props['selected'] === true);
    expect(selected).toHaveLength(2);
  });
});

describe('SearchableSelect under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });
  afterEach(clearSolidRuntime);

  const mount = (props: Record<string, unknown>, focusSelect = false) => {
    const {
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot,
    } = solid;
    setSolidRuntime({
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot,
    });
    const field = new FakeElement('input');
    const form = new FakeElement('form');
    const focused: string[] = [];
    const validity: string[] = [];
    Object.assign(field, {
      form,
      focus: () => focused.push('combobox'),
      setCustomValidity: (message: string) => validity.push(message),
    });
    const selectElement = new FakeElement('select');
    const dom = installFakeDom(new FakeElement('div'));
    if (focusSelect) dom.document.activeElement = selectElement;
    let output: unknown;
    let dispose = (): void => {};
    try {
      solid.createRoot((done) => {
        dispose = done;
        output = SearchableSelect(props as never);
        // The ref the first render hands out is the select's — attached before the effect runs.
        attachRef(one(byTag(nodesOf(output), 'select'), '<select>'), selectElement);
      });
    } finally {
      dom.restore();
    }
    const nodes = (): RenderNode[] => nodesOf(output);
    const combobox = (): RenderNode =>
      one(withAttr(nodes(), 'role', 'combobox'), 'role="combobox"');
    // The field's ref, as Solid would hand it once the swap rendered it.
    attachRef(one(withAttr(nodesOf(output), 'role', 'combobox'), 'role="combobox"'), field);
    return { nodes, combobox, focused, form, validity, dispose: () => dispose() };
  };

  test('after the effect: a combobox, focus kept on the swap, the value posted hidden', async () => {
    const view = mount({ name: 'tz', options: ZONES, value: 'Europe/Zurich' }, true);
    expect(byTag(view.nodes(), 'select')).toHaveLength(0);
    expect(view.combobox().props['value']).toBe('Zürich');
    expect(view.combobox().props['name']).toBeUndefined();
    await Promise.resolve();
    expect(view.focused).toEqual(['combobox']);
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Zurich']]);
    view.dispose();
  });

  test('typing a non-option then blurring posts the previous value, never the text', () => {
    const view = mount({ name: 'tz', options: ZONES, value: 'Europe/Berlin' });
    fire(view.combobox(), 'onInput', { currentTarget: { value: 'Atlantis' } });
    expect(view.combobox().props['value']).toBe('Atlantis');
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Berlin']]);
    fire(view.combobox(), 'onBlur', {});
    expect(view.combobox().props['value']).toBe('Berlin');
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Berlin']]);
    view.dispose();
  });

  test('typing, arrows and Enter pick by value; the label shows, the value posts', () => {
    const changes: string[] = [];
    const view = mount({ name: 'tz', options: ZONES, onChange: (v: string) => changes.push(v) });
    fire(view.combobox(), 'onInput', { currentTarget: { value: 'zur' } });
    expect(view.combobox().props['aria-expanded']).toBe('true');
    const active = view.combobox().props['aria-activedescendant'];
    expect(
      one(withAttr(view.nodes(), 'id', String(active)), 'active row').props['data-value'],
    ).toBe('Europe/Zurich');
    const enter = keydown('Enter');
    fire(view.combobox(), 'onKeyDown', enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(changes).toEqual(['Europe/Zurich']);
    expect(view.combobox().props['value']).toBe('Zürich');
    expect(view.combobox().props['aria-expanded']).toBe('false');
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Zurich']]);
    view.dispose();
  });

  test('Tab closes without picking; Backspace on an empty query drops the newest chip', () => {
    const view = mount({ name: 'tz', options: ZONES, multiple: true, value: ['Europe/Berlin'] });
    fire(view.combobox(), 'onKeyDown', keydown('ArrowDown'));
    fire(view.combobox(), 'onKeyDown', keydown('ArrowDown'));
    fire(view.combobox(), 'onKeyDown', keydown('Tab'));
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Berlin']]);
    fire(view.combobox(), 'onKeyDown', keydown('ArrowDown'));
    fire(view.combobox(), 'onKeyDown', keydown('ArrowDown'));
    fire(view.combobox(), 'onKeyDown', keydown('Enter'));
    expect(posted(view.nodes())).toEqual([
      ['tz', 'Europe/Berlin'],
      ['tz', 'Europe/Zurich'],
    ]);
    fire(view.combobox(), 'onKeyDown', keydown('Escape'));
    fire(view.combobox(), 'onKeyDown', keydown('Backspace'));
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Berlin']]);
    view.dispose();
  });

  test('form.reset restores the value the control was rendered with', async () => {
    const view = mount({ name: 'tz', options: ZONES, value: 'Europe/Berlin' });
    await Promise.resolve();
    fire(view.combobox(), 'onInput', { currentTarget: { value: 'york' } });
    fire(view.combobox(), 'onKeyDown', keydown('Enter'));
    expect(posted(view.nodes())).toEqual([['tz', 'America/New_York']]);
    view.form.dispatch('reset', {});
    expect(posted(view.nodes())).toEqual([['tz', 'Europe/Berlin']]);
    view.dispose();
  });

  test('required with nothing chosen refuses the submit, however much was typed', async () => {
    const view = mount({ name: 'tz', options: ZONES, required: true });
    await Promise.resolve();
    expect(view.validity.at(-1)).not.toBe('');
    fire(view.combobox(), 'onInput', { currentTarget: { value: 'Atlantis' } });
    expect(view.validity.at(-1)).not.toBe('');
    fire(view.combobox(), 'onInput', { currentTarget: { value: 'ber' } });
    fire(view.combobox(), 'onKeyDown', keydown('Enter'));
    expect(view.validity.at(-1)).toBe('');
    view.dispose();
  });
});
