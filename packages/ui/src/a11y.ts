// Keyboard and screen-reader plumbing shared by the interactive components.
// The decision logic is pure (and tested); only the thin shells touch the DOM.

import type { Direction } from '@ultimat3/i18n';

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let idCounter = 0;

/**
 * Stable-per-render unique id for label/description wiring. Prefixed so a
 * hydration mismatch is obvious in the DOM rather than silent.
 */
export function useId(prefix = 'u'): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

/** Test-only: make id assertions deterministic. */
export function resetIdCounter(): void {
  idCounter = 0;
}

/**
 * `aria-busy`, `aria-checked`, `aria-disabled`, `aria-expanded`, `aria-invalid`,
 * `aria-pressed` and `aria-selected` are ENUMERATED attributes, not boolean ones: their
 * values are the literal strings "true" and "false", and an absent attribute is a third,
 * different state. Converting at the DOM boundary keeps `undefined` meaning "omit" instead
 * of collapsing it into "false".
 */
export function ariaBool(value: boolean | undefined): 'true' | 'false' | undefined {
  if (value === undefined) return undefined;
  return value ? 'true' : 'false';
}

export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

export interface FocusTrap {
  activate(): void;
  release(): void;
}

/**
 * Cycles Tab within `root` and restores focus to the previously active element
 * on release — the behaviour Dialog and Drawer both need.
 */
export function createFocusTrap(root: HTMLElement): FocusTrap {
  let previous: HTMLElement | null = null;

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = focusableWithin(root);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    activate() {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.addEventListener('keydown', onKeyDown);
      (focusableWithin(root)[0] ?? root).focus();
    },
    release() {
      root.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    },
  };
}

export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

export interface RovingOptions {
  orientation?: RovingOrientation;
  dir?: Direction;
  loop?: boolean;
}

/**
 * Pure roving-tabindex reducer. Returns the next index, or the current one when
 * the key is not a navigation key. Inline arrows invert under `dir: 'rtl'`.
 */
export function nextRovingIndex(
  current: number,
  key: string,
  count: number,
  options: RovingOptions = {},
): number {
  if (count <= 0) return -1;
  const { orientation = 'horizontal', dir = 'ltr', loop = true } = options;
  const inline = orientation !== 'vertical';
  const block = orientation !== 'horizontal';
  const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

  let step = 0;
  if (inline && key === forward) step = 1;
  else if (inline && key === backward) step = -1;
  else if (block && key === 'ArrowDown') step = 1;
  else if (block && key === 'ArrowUp') step = -1;
  else if (key === 'Home') return 0;
  else if (key === 'End') return count - 1;
  else return current;

  const raw = current + step;
  if (loop) return (raw + count) % count;
  return Math.min(count - 1, Math.max(0, raw));
}

/** Wire a roving group: one tabbable item, arrows move focus and selection. */
export function createRovingTabindex(
  getItems: () => readonly HTMLElement[],
  options: RovingOptions = {},
): (event: KeyboardEvent) => void {
  return (event) => {
    const items = getItems();
    const active = document.activeElement;
    // Focus may sit on nothing, on `<body>`, or on a non-HTML element (an SVG child): none of
    // those are in `items`, and all of them mean "start from the first item".
    const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const next = nextRovingIndex(Math.max(current, 0), event.key, items.length, options);
    if (next === current || next < 0) return;
    event.preventDefault();
    for (const [index, item] of items.entries()) {
      item.tabIndex = index === next ? 0 : -1;
    }
    items[next]?.focus();
  };
}

export type Politeness = 'polite' | 'assertive';

const LIVE_REGION_ID = 'ultimate-live-region';

/**
 * Announce a message to assistive tech. Uses one persistent region per
 * politeness level, because creating a region and writing to it in the same
 * frame is not announced by most screen readers.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  if (typeof document === 'undefined') return;
  const id = `${LIVE_REGION_ID}-${politeness}`;
  let region = document.getElementById(id);
  if (region === null) {
    region = document.createElement('div');
    region.id = id;
    region.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    region.setAttribute('aria-live', politeness);
    region.setAttribute('aria-atomic', 'true');
    region.style.cssText =
      'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%)';
    document.body.appendChild(region);
  }
  region.textContent = '';
  // Empty-then-write in a later task so repeated identical messages re-announce.
  queueMicrotask(() => {
    if (region !== null) region.textContent = message;
  });
}
