// The rules are asked here with nothing attached and nothing rendered — the `ArrowKeyElement` and
// `RovingItem` interfaces are structural precisely so this file can. `a11y.test.ts` asks the other
// question, against `fake-dom`: a correct answer that is then focused into a control which refuses
// focus looks identical from in here, so neither file replaces the other.

import { describe, expect, test } from 'bun:test';
import { handlesOwnArrowKeys, MENU_ITEM_SELECTOR, TAB_SELECTOR, tabStopIndex } from './roving';

const element = (tagName: string, attrs: Record<string, string> = {}) => ({
  tagName,
  getAttribute: (name: string): string | null => attrs[name] ?? null,
});

describe('the roving item selectors', () => {
  test('exclude disabled controls, because focus() on one is a no-op', () => {
    expect(MENU_ITEM_SELECTOR).toBe('[role="menuitem"]:not([disabled])');
    expect(TAB_SELECTOR).toBe('[role="tab"]:not([disabled])');
  });
});

describe('tabStopIndex', () => {
  const items = [{ disabled: false }, { disabled: true }, {}];

  test('with no selection, the first ENABLED item holds the group tab stop', () => {
    expect(tabStopIndex(items)).toBe(0);
    // The bug this replaces: index 0 always held it, so a leading disabled item left NOTHING
    // tabbable and the group could not be entered from the keyboard at all.
    expect(tabStopIndex([{ disabled: true }, { disabled: false }])).toBe(1);
  });

  test('a selection holds it, unless the selected item is disabled or out of range', () => {
    expect(tabStopIndex(items, 2)).toBe(2);
    expect(tabStopIndex(items, 1)).toBe(0);
    expect(tabStopIndex(items, -1)).toBe(0);
    expect(tabStopIndex(items, 9)).toBe(0);
  });

  test('every item disabled means nothing is tabbable, which is the honest answer', () => {
    expect(tabStopIndex([{ disabled: true }, { disabled: true }])).toBe(-1);
    expect(tabStopIndex([])).toBe(-1);
  });
});

describe('handlesOwnArrowKeys', () => {
  test('a text-ish input, a textarea, a select and a contenteditable keep their arrows', () => {
    expect(handlesOwnArrowKeys(element('INPUT'))).toBe(true);
    expect(handlesOwnArrowKeys(element('input', { type: 'search' }))).toBe(true);
    expect(handlesOwnArrowKeys(element('INPUT', { type: 'NUMBER' }))).toBe(true);
    expect(handlesOwnArrowKeys(element('TEXTAREA'))).toBe(true);
    expect(handlesOwnArrowKeys(element('SELECT'))).toBe(true);
    expect(handlesOwnArrowKeys(element('DIV', { contenteditable: '' }))).toBe(true);
    // A range slider and a radio move on arrows too — "text-ish" is the wrong rule, "answers
    // arrows itself" is the right one.
    expect(handlesOwnArrowKeys(element('input', { type: 'range' }))).toBe(true);
    expect(handlesOwnArrowKeys(element('input', { type: 'radio' }))).toBe(true);
  });

  test('a button, a checkbox and a plain element have no arrow behaviour to protect', () => {
    expect(handlesOwnArrowKeys(element('BUTTON'))).toBe(false);
    expect(handlesOwnArrowKeys(element('input', { type: 'checkbox' }))).toBe(false);
    expect(handlesOwnArrowKeys(element('input', { type: 'submit' }))).toBe(false);
    expect(handlesOwnArrowKeys(element('A', { href: '/x' }))).toBe(false);
    expect(handlesOwnArrowKeys(element('DIV', { contenteditable: 'false' }))).toBe(false);
    expect(handlesOwnArrowKeys(null)).toBe(false);
  });
});
