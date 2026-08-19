// The pure rules of a roving-tabindex group: which items it navigates, which one holds the
// group's single tab stop, and which elements answer arrow keys themselves. Pure so the rules are
// testable with no renderer — the package's `*-view.ts` convention, applied to keyboard behaviour.

/**
 * A roving group queries its OWN items rather than reusing `FOCUSABLE_SELECTOR`, and both
 * selectors end in `:not([disabled])` for the same reason that one does: `focus()` on a disabled
 * control is a NO-OP. A disabled item left in the list pins the reducer on its index forever —
 * every press recomputes the same unreachable index — so everything after it is unreachable by
 * keyboard, permanently.
 */
export const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';
export const TAB_SELECTOR = '[role="tab"]:not([disabled])';

/** The only thing the tab-stop rule needs to know about an item. */
export interface RovingItem {
  readonly disabled?: boolean | undefined;
}

/**
 * The one index that carries `tabindex="0"`. `selected` is the caller's chosen index, `-1` for a
 * group with no selection; a disabled or out-of-range selection falls back to the first ENABLED
 * item, because a group whose only tab stop is disabled cannot be entered at all. Answers `-1`
 * when every item is disabled — then nothing is tabbable, which is the correct answer.
 */
export function tabStopIndex(items: readonly RovingItem[], selected = -1): number {
  const chosen = items[selected];
  if (selected >= 0 && chosen !== undefined && chosen.disabled !== true) return selected;
  return items.findIndex((item) => item.disabled !== true);
}

/** Structural on purpose: a real `Element` satisfies it, and a test needs no DOM to build one. */
export interface ArrowKeyElement {
  readonly tagName: string;
  getAttribute(name: string): string | null;
}

// Input types with no arrow-key behaviour of their own. Everything else — text, search, number,
// date, range, radio — moves a caret, a value or a selection when an arrow is pressed.
const ARROW_INERT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'file',
  'hidden',
  'image',
  'reset',
  'submit',
]);

/**
 * Does this element already answer arrow keys itself? A roving group must never `preventDefault()`
 * on one that does. `Toolbar`'s documented purpose is search and filters at the inline start, and
 * swallowing ArrowRight from that `Input` eats the keystroke that was moving the caret.
 */
export function handlesOwnArrowKeys(element: ArrowKeyElement | null | undefined): boolean {
  if (element === null || element === undefined) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = element.getAttribute('type') ?? 'text';
    return !ARROW_INERT_INPUT_TYPES.has(type.toLowerCase());
  }
  const editable = element.getAttribute('contenteditable');
  return editable !== null && editable !== 'false';
}
