import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ariaBool,
  createFocusTrap,
  createRovingTabindex,
  FOCUSABLE_SELECTOR,
  focusableWithin,
  nextRovingIndex,
  resetIdCounter,
  useId,
} from './a11y';
import { FakeElement, installFakeDom, keydown } from './fake-dom';
import { MENU_ITEM_SELECTOR } from './roving';

describe('useId', () => {
  beforeEach(resetIdCounter);

  test('is unique and prefixed for label wiring', () => {
    const a = useId('field');
    const b = useId('field');
    expect(a).not.toBe(b);
    expect(a.startsWith('field-')).toBe(true);
  });
});

describe('nextRovingIndex', () => {
  test('moves and wraps along the inline axis', () => {
    expect(nextRovingIndex(0, 'ArrowRight', 3)).toBe(1);
    expect(nextRovingIndex(2, 'ArrowRight', 3)).toBe(0);
    expect(nextRovingIndex(0, 'ArrowLeft', 3)).toBe(2);
  });

  test('inline arrows invert in RTL so the keyboard matches the visual order', () => {
    expect(nextRovingIndex(0, 'ArrowLeft', 3, { dir: 'rtl' })).toBe(1);
    expect(nextRovingIndex(1, 'ArrowRight', 3, { dir: 'rtl' })).toBe(0);
  });

  test('respects orientation', () => {
    expect(nextRovingIndex(0, 'ArrowDown', 3, { orientation: 'horizontal' })).toBe(0);
    expect(nextRovingIndex(0, 'ArrowDown', 3, { orientation: 'vertical' })).toBe(1);
    expect(nextRovingIndex(0, 'ArrowRight', 3, { orientation: 'vertical' })).toBe(0);
    expect(nextRovingIndex(0, 'ArrowRight', 3, { orientation: 'both' })).toBe(1);
  });

  test('Home and End jump to the ends; loop can be disabled', () => {
    expect(nextRovingIndex(1, 'Home', 4)).toBe(0);
    expect(nextRovingIndex(1, 'End', 4)).toBe(3);
    expect(nextRovingIndex(3, 'ArrowRight', 4, { loop: false })).toBe(3);
    expect(nextRovingIndex(0, 'ArrowLeft', 4, { loop: false })).toBe(0);
  });

  test('non-navigation keys and empty groups are inert', () => {
    expect(nextRovingIndex(2, 'a', 4)).toBe(2);
    expect(nextRovingIndex(0, 'ArrowRight', 0)).toBe(-1);
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  test('excludes disabled controls and tabindex -1', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).not.toContain('button,');
  });
});

describe('ariaBool', () => {
  test('renders enumerated strings and keeps undefined as "omit the attribute"', () => {
    expect(ariaBool(true)).toBe('true');
    expect(ariaBool(false)).toBe('false');
    expect(ariaBool(undefined)).toBeUndefined();
  });
});

// --- the wired helpers, against a DOM ---------------------------------------------------------
// The gap that let three of these bugs ship: only the pure reducer above was ever tested, so a
// handler that computed the right INDEX and then focused an element that refuses focus looked
// correct in every assertion the package had.

describe('createRovingTabindex, attached', () => {
  const menu = (...flags: readonly boolean[]): { list: FakeElement; items: FakeElement[] } => {
    const list = new FakeElement('div', { role: 'menu' });
    const items = flags.map(
      (disabled, index) =>
        new FakeElement('button', {
          role: 'menuitem',
          tabindex: index === 0 ? '0' : '-1',
          ...(disabled ? { disabled: '' } : {}),
        }),
    );
    list.append(...items);
    return { list, items };
  };

  const rove = (list: FakeElement, selector: string): ((event: KeyboardEvent) => void) =>
    createRovingTabindex(
      () => list.querySelectorAll(selector) as unknown as readonly HTMLElement[],
      { orientation: 'vertical' },
    );

  test('a disabled item does not swallow the group: every enabled item stays reachable', () => {
    const { list, items } = menu(false, true, false);
    const dom = installFakeDom(list);
    try {
      const handler = rove(list, MENU_ITEM_SELECTOR);
      items[0]?.focus();
      handler(keydown('ArrowDown') as never);
      // Without `:not([disabled])` the reducer answers index 1 forever, `focus()` on the disabled
      // button does nothing, and item 2 is unreachable however many times ArrowDown is pressed.
      expect(dom.document.activeElement).toBe(items[2] as FakeElement);
      expect(items[1]?.focusCount).toBe(0);
      // And the group is two items wide now, not three: the next press wraps to the first.
      handler(keydown('ArrowDown') as never);
      expect(dom.document.activeElement).toBe(items[0] as FakeElement);
    } finally {
      dom.restore();
    }
  });

  test('a key the reducer does not navigate leaves focus alone, even from outside the group', () => {
    const { list, items } = menu(false, false);
    // A button, not a text input: this test is about the index comparison alone, and a control
    // that answers its own arrows would leave through the guard above it instead.
    const outside = new FakeElement('button');
    const page = new FakeElement('div').append(list, outside);
    const dom = installFakeDom(page);
    try {
      const handler = rove(list, MENU_ITEM_SELECTOR);
      dom.document.activeElement = outside;
      const event = keydown('Tab');
      handler(event as never);
      // The clamped index went into the reducer and the UNCLAMPED one came back out of the
      // comparison, so every non-navigation key looked like a move.
      expect(event.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(outside);
      expect(items[0]?.focusCount).toBe(0);
    } finally {
      dom.restore();
    }
  });

  test('a control that answers arrows itself keeps them — the Toolbar search field', () => {
    const { list, items } = menu(false, false);
    const search = new FakeElement('input', { type: 'search' });
    const strip = new FakeElement('div', { role: 'toolbar' }).append(search, list);
    const dom = installFakeDom(strip);
    try {
      const handler = rove(strip, MENU_ITEM_SELECTOR);
      dom.document.activeElement = search;
      const event = keydown('ArrowDown');
      handler(event as never);
      expect(event.defaultPrevented).toBe(false);
      expect(dom.document.activeElement).toBe(search);
      expect(items[0]?.focusCount).toBe(0);
    } finally {
      dom.restore();
    }
  });
});

describe('createFocusTrap', () => {
  const panel = (): { root: FakeElement; page: FakeElement; buttons: FakeElement[] } => {
    const root = new FakeElement('div');
    const buttons = [new FakeElement('button'), new FakeElement('button')];
    root.append(...buttons);
    const trigger = new FakeElement('button');
    const page = new FakeElement('div').append(trigger, root);
    return { root, page, buttons };
  };

  test('moves focus in on activate and hands it back to the trigger on release', () => {
    const { root, page, buttons } = panel();
    const dom = installFakeDom(page);
    try {
      const trigger = page.children[0] as FakeElement;
      trigger.focus();
      const trap = createFocusTrap(root as unknown as HTMLElement);
      trap.activate();
      expect(dom.document.activeElement).toBe(buttons[0] as FakeElement);
      trap.release();
      // Without the restore, closing leaves focus on <body> and the next Tab restarts the document.
      expect(dom.document.activeElement).toBe(trigger);
    } finally {
      dom.restore();
    }
  });

  // `Menu` hands the trap a `<div role="menu">` and `Popover` a `<div>`; neither carries a
  // tabindex, and `focus()` on such an element is a no-op that reports nothing. So the fallback
  // that exists to keep focus inside an empty panel left it wherever it already was — outside.
  test('an empty panel takes focus itself, which a plain <div> can only do once told to', () => {
    const root = new FakeElement('div', { role: 'menu' });
    const trigger = new FakeElement('button');
    const page = new FakeElement('div').append(trigger, root);
    const dom = installFakeDom(page);
    try {
      trigger.focus();
      const trap = createFocusTrap(root as unknown as HTMLElement);
      trap.activate();
      expect(root.getAttribute('tabindex')).toBe('-1');
      expect(dom.document.activeElement).toBe(root);
      // -1, never 0: the root is reachable programmatically and is not a Tab stop of its own, so
      // `focusableWithin` still answers with the trigger alone.
      expect(focusableWithin(page as unknown as ParentNode)).toHaveLength(1);
      // And the Tab branch keeps it there rather than letting the key escape the empty panel.
      dom.document.activeElement = trigger;
      dom.document.dispatch('keydown', keydown('Tab'));
      expect(dom.document.activeElement).toBe(root);
    } finally {
      dom.restore();
    }
  });

  test('a root that already declares a tabindex keeps the one it was given', () => {
    const root = new FakeElement('div', { role: 'dialog', tabindex: '0' });
    const page = new FakeElement('div').append(root);
    const dom = installFakeDom(page);
    try {
      createFocusTrap(root as unknown as HTMLElement).activate();
      expect(root.getAttribute('tabindex')).toBe('0');
      expect(dom.document.activeElement).toBe(root);
    } finally {
      dom.restore();
    }
  });

  test('recaptures focus that already left the root — the branch a root-scoped listener never saw', () => {
    const { root, page, buttons } = panel();
    const dom = installFakeDom(page);
    try {
      const trap = createFocusTrap(root as unknown as HTMLElement);
      trap.activate();
      const trigger = page.children[0] as FakeElement;
      dom.document.activeElement = trigger;
      // A keydown while focus is OUTSIDE never reaches the root, so a listener attached there
      // could not run at all; on `document` it runs and pulls focus back.
      dom.document.dispatch('keydown', keydown('Tab'));
      expect(dom.document.activeElement).toBe(buttons[0] as FakeElement);
      trap.release();
      expect(dom.document.listeners.get('keydown')?.size ?? 0).toBe(0);
    } finally {
      dom.restore();
    }
  });
});
