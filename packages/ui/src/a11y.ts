// Keyboard and screen-reader plumbing shared by the interactive components.
// The decision logic is pure (and tested); only the thin shells touch the DOM.

import type { Direction } from '@ultimat3/i18n';
import { handlesOwnArrowKeys } from './roving';

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
 * Unique id for label/description wiring, from a PROCESS-wide counter. Prefixed so a mismatch is
 * obvious in the DOM rather than silent.
 *
 * Correct for the only render path that exists: a server render walks a tree once, so every id in
 * one document is distinct, which is all `for`/`aria-describedby` need. It is NOT stable across two
 * renders of the same tree — a second process, or a client re-render, starts its own count — so it
 * cannot survive hydration. That is latent rather than broken: this package has no client runtime
 * (see CLAUDE.md), so nothing re-renders a server tree yet. Making it survive needs a
 * RENDER-SCOPED counter, which means a seam in `@ultimat3/render` (or a `SolidRuntime` member);
 * resetting this one per request would only move the collision. Do not paper over it here.
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
 * Cycles Tab within `root`, moves focus into it on `activate`, and restores focus to the element
 * that had it on `release` — what `Menu` and `Popover` need, because a panel unmounted with focus
 * inside it resets focus to `<body>` and the next Tab restarts at the top of the document.
 *
 * The listener sits on `document`, not on `root`: a keydown while focus is OUTSIDE never reaches
 * `root`, so a trap listening on its own root can never recapture focus that already left — the
 * branch that pulls it back was unreachable by construction. Every branch still tests
 * `root.contains`, so the trap only acts while it is the active one.
 */
export function createFocusTrap(root: HTMLElement): FocusTrap {
  let previous: HTMLElement | null = null;

  /**
   * The empty-panel fallback, and the reason it needs a line of its own: a plain `<div>` is not
   * focusable, so `focus()` on it is a no-op that reports nothing — and `Menu` and `Popover` both
   * hand this trap exactly that. `tabindex="-1"` is the one value that makes an element reachable
   * programmatically without putting it in the Tab order, so the root never becomes a stop of its
   * own (`FOCUSABLE_SELECTOR` excludes `-1`). A root that already declares one keeps it.
   */
  function focusRoot(): void {
    if (root.getAttribute('tabindex') === null) root.tabIndex = -1;
    root.focus();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = focusableWithin(root);
    if (items.length === 0) {
      event.preventDefault();
      focusRoot();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement;
    const outside = !root.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    activate() {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener('keydown', onKeyDown);
      const first = focusableWithin(root)[0];
      if (first === undefined) focusRoot();
      else first.focus();
    },
    release() {
      document.removeEventListener('keydown', onKeyDown);
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
    // A control with its own arrow-key behaviour keeps it. A group cannot know whether the caret
    // in the Input it contains was about to move, so it never guesses — it declines.
    if (handlesOwnArrowKeys(active)) return;
    // Focus may sit on nothing, on `<body>`, or on a non-HTML element (an SVG child): none of
    // those are in `items`, and all of them mean "start from the first item".
    const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const start = Math.max(current, 0);
    const next = nextRovingIndex(start, event.key, items.length, options);
    // Compared against `start`, the value the reducer was actually given — not the unclamped
    // `current`. A key the reducer does not navigate answers its own input, so comparing against
    // `-1` made every such key (Tab included) look like a move and steal focus out of whatever
    // held it whenever the active element was not one of the group's items.
    if (next === start || next < 0) return;
    event.preventDefault();
    for (const [index, item] of items.entries()) {
      item.tabIndex = index === next ? 0 : -1;
    }
    items[next]?.focus();
  };
}

export type Politeness = 'polite' | 'assertive';

/**
 * One region per politeness level — this plus `-polite` / `-assertive` is the id — and this on its
 * own is the CLASS both of them wear, because they are hidden identically.
 *
 * A class, and not the `region.style.cssText` this wrote until 19.1.3: a style a script applies at
 * runtime is not among the inline `<style>` bodies the framework's own CSP hashed at render time
 * (`packages/cli/src/style-csp.ts`, sent by `dev-roles.ts`), so a clean browser logged `Applying
 * inline style violates the following Content Security Policy directive 'style-src'` on every page
 * load — and an app that promotes that report-only policy to enforcing would have the declaration
 * dropped and the announcement painted on screen as visible page content. The rules live in
 * `tokens/reset.scss`, through the same `visually-hidden` mixin every other off-screen label in
 * this package uses.
 *
 * That the app loads this package's global stylesheet is not a new assumption — every rule this
 * package emits reads a custom property from it, and `x verify` refuses a document defining none
 * (`X_STYLES_GLOBAL_MISSING`). Being ANNOUNCED does not depend on it either way: `aria-live` is
 * read off the accessibility tree, so a region with no stylesheet is still read out, and only the
 * hiding is lost.
 */
const LIVE_REGION_ID = 'ultimate-live-region';

/** Both levels, in the order `AppShell` emits them. One region per politeness, never per message. */
export const LIVE_REGION_LEVELS: readonly Politeness[] = ['polite', 'assertive'];

/** The attributes ONE live region carries. */
export interface LiveRegionAttrs {
  readonly id: string;
  readonly class: string;
  readonly role: 'status' | 'alert';
  readonly 'aria-live': Politeness;
  readonly 'aria-atomic': 'true';
}

/**
 * One derivation, read by both halves — `AppShell`, which renders these regions into the SERVER
 * response, and `announce()`, which writes into them. That ordering is the reason this exists at
 * all: a live region created and filled in the same frame is not announced by most screen readers,
 * so the region that carries the first message has to predate the message. `announce()`'s own
 * fallback (below) can only ever be right from its second call onwards; a shell that already
 * emitted the region makes the first one right too.
 *
 * `aria-atomic="true"` is correct HERE and wrong on `ToastRegion`'s `<ol>`: this element holds one
 * message at a time and is re-read whole, where the toast list holds several and must announce
 * only the arrival.
 */
export function liveRegionAttrs(politeness: Politeness): LiveRegionAttrs {
  return {
    id: `${LIVE_REGION_ID}-${politeness}`,
    class: LIVE_REGION_ID,
    role: politeness === 'assertive' ? 'alert' : 'status',
    'aria-live': politeness,
    'aria-atomic': 'true',
  };
}

/**
 * Announce a message to assistive tech — for a state change with no surface of its own: "12
 * results", "sorted by name, descending", "page 3 of 9". NOT for a notification, which is a
 * `Toast` in the `ToastRegion` that owns its own live semantics; two announcement paths for one
 * message is how a screen reader ends up reading it twice.
 *
 * Writes into the region `AppShell` already rendered. The create-if-absent branch is the fallback
 * for a tree with no shell, and it carries this module's known limit: the region it builds is
 * appended and written in the same frame, so the FIRST message through it may be silent.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  if (typeof document === 'undefined') return;
  const attrs = liveRegionAttrs(politeness);
  let region = document.getElementById(attrs.id);
  if (region === null) {
    region = document.createElement('div');
    region.id = attrs.id;
    region.className = attrs.class;
    region.setAttribute('role', attrs.role);
    region.setAttribute('aria-live', attrs['aria-live']);
    region.setAttribute('aria-atomic', attrs['aria-atomic']);
    document.body.appendChild(region);
  }
  region.textContent = '';
  // Empty-then-write in a later task so repeated identical messages re-announce.
  queueMicrotask(() => {
    if (region !== null) region.textContent = message;
  });
}
