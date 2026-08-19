// What a keypress, a drop and a click actually DO — asked of the components, not of the helpers
// underneath them. The package's rule is that a rule lives in a pure module beside the `.tsx`, and
// it holds; what it never covered is the WIRING, so a component could pass the wrong selector to a
// correct helper, or never hand a dropped file to the input it renders, and nothing noticed.
//
// The tree comes from `jsx-probe` (the props an element carries) and the DOM from `fake-dom` (a
// focus that a disabled control refuses). `document` is installed only around the keyboard
// dispatch: a DOM present during a render is what `solid()` reads as "client", and it throws.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FakeElement, installFakeDom, keydown } from '../fake-dom';
import {
  attachRef,
  byTag,
  fire,
  one,
  type ProbeNode,
  probe,
  renderNodes,
  unprobe,
  withAttr,
} from '../jsx-probe';
import { MENU_ITEM_SELECTOR } from '../roving';
import { Checkbox } from './Checkbox';
import { Dropzone } from './Dropzone';
import { Form } from './Form';
import { Menu } from './Menu';
import { Pagination } from './Pagination';
import { Select } from './Select';
import { Switch } from './Switch';
import { Table } from './Table';
import { Tabs } from './Tabs';
import { Toast, ToastRegion } from './Toast';
import { Toolbar } from './Toolbar';

const menuItem = (id: string, disabled = false): Record<string, unknown> => ({
  id,
  label: id,
  onSelect: (): void => {},
  ...(disabled ? { disabled: true } : {}),
});

const menuProps = (items: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  items,
  open: true,
  onOpenChange: (): void => {},
  trigger: (): string => 'open',
  label: 'Actions',
});

const tabindexes = (nodes: readonly ProbeNode[], role: string): unknown[] =>
  withAttr(nodes, 'role', role).map((node) => node.props['tabindex']);

describe('component keyboard and form wiring', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the components under test compile to a JSX factory this file understands', () => {
    expect(renderNodes(Table, { caption: 'Rows', children: null }).length).toBeGreaterThan(0);
  });

  // --- finding: a disabled item made the rest of the group unreachable ------------------------

  test('Menu puts its one tab stop on the first ENABLED item, never on a disabled one', () => {
    const nodes = renderNodes(Menu, menuProps([menuItem('edit', true), menuItem('delete')]));
    // `index === 0 ? 0 : -1` put it on the disabled item, and a disabled control cannot take
    // focus — so the menu had no tab stop at all and could not be entered from the keyboard.
    expect(tabindexes(nodes, 'menuitem')).toEqual([-1, 0]);
  });

  test('Menu walks past a disabled item instead of stalling on it, through its own handler', () => {
    const nodes = renderNodes(
      Menu,
      menuProps([menuItem('edit'), menuItem('archive', true), menuItem('delete')]),
    );
    const panel = one(withAttr(nodes, 'role', 'menu'), 'role="menu" element');

    const list = new FakeElement('div', { role: 'menu' });
    const items = [
      new FakeElement('button', { role: 'menuitem', tabindex: '0' }),
      new FakeElement('button', { role: 'menuitem', tabindex: '-1', disabled: '' }),
      new FakeElement('button', { role: 'menuitem', tabindex: '-1' }),
    ];
    list.append(...items);
    const dom = installFakeDom(list);
    try {
      attachRef(panel, list);
      items[0]?.focus();
      fire(panel, 'onKeyDown', keydown('ArrowDown'));
      expect(dom.document.activeElement).toBe(items[2] as FakeElement);
    } finally {
      dom.restore();
    }
    // And the selector the component hands the helper is the one that excludes them.
    expect(list.querySelectorAll(MENU_ITEM_SELECTOR)).toHaveLength(2);
  });

  test('Tabs falls back to the first enabled tab when the selected one is disabled', () => {
    const items = [
      { id: 'one', label: 'One', panel: null, disabled: true },
      { id: 'two', label: 'Two', panel: null },
    ];
    const nodes = renderNodes(Tabs, { items, value: 'one', onChange: () => {}, label: 'Sections' });
    expect(tabindexes(nodes, 'tab')).toEqual([-1, 0]);
  });

  // --- finding: the toolbar stole arrow keys from the field it exists to hold -----------------

  test('Toolbar declines the arrow key while a text field inside it has focus', () => {
    const nodes = renderNodes(Toolbar, { children: null, label: 'Filters' });
    const strip = one(withAttr(nodes, 'role', 'toolbar'), 'role="toolbar" element');

    const search = new FakeElement('input', { type: 'search' });
    const action = new FakeElement('button');
    const element = new FakeElement('div', { role: 'toolbar' }).append(search, action);
    const dom = installFakeDom(element);
    try {
      attachRef(strip, element);
      dom.document.activeElement = search;
      const event = keydown('ArrowRight');
      fire(strip, 'onKeyDown', event);
      // Typing then pressing ArrowRight to move the caret used to move FOCUS instead, and the
      // keystroke was swallowed by `preventDefault()` on the way.
      expect(event.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(search);
      expect(action.focusCount).toBe(0);
    } finally {
      dom.restore();
    }
  });

  // --- finding: the toast region was not a live region ---------------------------------------

  test('ToastRegion carries the live semantics, on the list that outlives every message', () => {
    const nodes = renderNodes(ToastRegion, { children: null, label: 'Notifications' });
    const list = one(byTag(nodes, 'ol'), '<ol>');
    expect(list.props['aria-live']).toBe('polite');
    expect(list.props['aria-atomic']).toBe('false');
    expect(one(byTag(nodes, 'section'), '<section>').props['aria-live']).toBeUndefined();
  });

  test('ToastRegion announces assertively only when the whole region is declared so', () => {
    const nodes = renderNodes(ToastRegion, {
      children: null,
      label: 'Errors',
      politeness: 'assertive',
    });
    expect(one(byTag(nodes, 'ol'), '<ol>').props['aria-live']).toBe('assertive');
  });

  test('a Toast is a plain list item: no second live region, no role stripping its listitem', () => {
    for (const tone of ['neutral', 'danger']) {
      const item = one(byTag(renderNodes(Toast, { children: 'Saved', tone }), 'li'), '<li>');
      // A live region created with its content already inside it is not announced, which is what
      // `aria-live` on the <li> produced — one brand-new region per message, each one silent.
      expect(item.props['aria-live']).toBeUndefined();
      expect(item.props['role']).toBeUndefined();
    }
  });

  // --- finding: an ARIA override froze the announced state ------------------------------------

  test('Checkbox writes aria-checked only for "mixed", the state with no attribute form', () => {
    const checked = one(
      byTag(renderNodes(Checkbox, { label: 'A', checked: true }), 'input'),
      'input',
    );
    expect(checked.props['aria-checked']).toBeUndefined();
    expect(checked.props['checked']).toBe(true);

    const mixed = one(
      byTag(renderNodes(Checkbox, { label: 'A', indeterminate: true }), 'input'),
      'input',
    );
    expect(mixed.props['aria-checked']).toBe('mixed');
  });

  test('Switch writes no aria-checked at all: role="switch" reads the native checkedness', () => {
    const input = one(byTag(renderNodes(Switch, { label: 'A', checked: true }), 'input'), 'input');
    expect(input.props['aria-checked']).toBeUndefined();
    expect(input.props['role']).toBe('switch');
    expect(input.props['checked']).toBe(true);
  });

  // --- finding: the pagination mode selector was inverted --------------------------------------

  test('Pagination pages by cursor when a cursor is present, whatever else it was given', () => {
    const cursors: string[] = [];
    const pages: number[] = [];
    const nodes = renderNodes(Pagination, {
      nextCursor: 'c1',
      page: 2,
      totalPages: 5,
      onCursor: (cursor: string) => cursors.push(cursor),
      onPage: (page: number) => pages.push(page),
    });
    // Numbered mode renders the "2 / 5" status; cursor mode renders none.
    expect(withAttr(nodes, 'aria-live')).toHaveLength(0);

    const buttons = byTag(nodes, 'button');
    expect(buttons).toHaveLength(2);
    fire(buttons[1] as ProbeNode, 'onClick', {});
    // The inverted selector called onPage(3) and dropped the cursor on the floor.
    expect(cursors).toEqual(['c1']);
    expect(pages).toEqual([]);
  });

  test('Pagination still numbers when it was given numbers and no cursor', () => {
    const pages: number[] = [];
    const nodes = renderNodes(Pagination, {
      page: 2,
      totalPages: 5,
      onPage: (page: number) => pages.push(page),
    });
    expect(withAttr(nodes, 'aria-live')).toHaveLength(1);
    fire(byTag(nodes, 'button')[1] as ProbeNode, 'onClick', {});
    expect(pages).toEqual([3]);
  });

  // --- finding: a dropped file never reached the form ------------------------------------------

  test('Dropzone hands a drop to the real input, so the form it sits in submits the file', () => {
    const selections: unknown[] = [];
    const nodes = renderNodes(Dropzone, {
      label: 'Drop files',
      name: 'avatar',
      required: true,
      onSelect: (selection: unknown) => selections.push(selection),
    });
    const input = { files: null as unknown };
    attachRef(one(byTag(nodes, 'input'), '<input>'), input);

    const files = [{ name: 'a.png', type: 'image/png', size: 10 }];
    const dropped = Object.assign(files, { length: 1 });
    fire(one(byTag(nodes, 'label'), '<label>'), 'onDrop', {
      preventDefault: () => {},
      dataTransfer: { files: dropped },
    });

    // `onSelect` always fired; `input.files` did not, so `required` blocked the submit on a file
    // the user could see in the accepted list.
    expect(input.files).toBe(dropped);
    expect(selections).toHaveLength(1);
  });

  // --- finding: a prop read once at setup instead of per use ------------------------------------

  test('Select reads props.value through a thunk, so a runtime can track it', () => {
    let reads = 0;
    const props = {
      name: 'status',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'sent', label: 'Sent' },
      ],
      placeholder: 'Choose',
      get value(): string {
        reads += 1;
        return 'sent';
      },
    };
    const nodes = renderNodes(Select, props as unknown as Record<string, unknown>);
    // `const current = props.value ?? ''` reads exactly once, at setup, OUTSIDE any tracking
    // scope — which is why the selection would freeze at the first render the moment a client
    // Solid runtime is registered, and `ThemeToggle` already feeds this a signal. A thunk called
    // from the JSX reads once per use instead.
    expect(reads).toBeGreaterThan(1);
    expect(withAttr(byTag(nodes, 'option'), 'selected', true)).toHaveLength(1);
  });

  // --- finding: a focus target nothing could aim at ---------------------------------------------

  test('Form hands its error summary a ref, so the focus move it promises has a subject', () => {
    const nodes = renderNodes(Form, { children: null, error: 'Check the fields above' });
    const summary = one(withAttr(nodes, 'tabindex', '-1'), 'tabindex="-1" element');
    // `summaryId` is internal, so no caller could ever move focus here and the component never
    // did. The effect that does is DOM-only and never runs on this path — the ref is the half a
    // server render can be held to.
    expect(typeof summary.props['ref']).toBe('function');
  });

  // --- finding: a duplicate accessible name ------------------------------------------------------

  test('Table names itself once, through its caption', () => {
    const nodes = renderNodes(Table, { caption: 'Rows', children: null });
    const scroller = one(byTag(nodes, 'section'), '<section>');
    // `aria-label` OVERRIDES the caption rather than adding to it, so the scroll box and the table
    // inside it were announced under the same name.
    expect(scroller.props['aria-label']).toBeUndefined();
    expect(scroller.props['tabindex']).toBe('0');
    expect(one(byTag(nodes, 'caption'), '<caption>').props['children']).toBe('Rows');
  });
});
