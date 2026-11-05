/**
 * `scheduleRefresh()`: "the server's page changed" said by a channel, paid when the visitor is not
 * in the middle of something. Coalesced to one running and one owed; held while the tab is hidden,
 * a dialog or popover is open, a field has focus, text is selected, a navigation runs, or within
 * `QUIET_MS` of input. State lives on `window` under one `Symbol.for` key: one per page, any chunk.
 */

import { type Clock, sessionIsLost, systemClock } from '@ultimat3/core/page';
import type { NavigationRouter } from './navigation';

/** How long after a scroll, wheel, key or press the page counts as being read. */
export const QUIET_MS = 1_000;

/** A press unreleased this long is a lost `pointerup`, not a visitor still pressing. */
export const PRESS_HOLD_MS = 10_000;

const KEY: unique symbol = Symbol.for('ultimate.refresh-idle');

/** What the scheduler reads of the window; injected by the tests. */
export interface IdleWindow {
  readonly document: Document;
  readonly __xNavigation?: Pick<NavigationRouter, 'refresh'> | undefined;
  addEventListener(type: string, fn: () => void, options?: AddEventListenerOptions): void;
  getSelection(): { readonly isCollapsed: boolean } | null;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

interface IdleState {
  running: boolean;
  owed: boolean;
  timer: number | undefined;
  lastInput: number;
  pressedAt: number | undefined;
  readonly schedule: () => void;
}

type StateHost = { [KEY]?: IdleState };

/**
 * Ask for the page on screen to be re-read once the visitor is idle. Never a reload: without the
 * client router this does nothing, because reloading a page under a reader is the failure it
 * exists to prevent. After a lost session (`sessionIsLost()`), nothing, ever.
 */
export function scheduleRefresh(): void {
  const win = (globalThis as { window?: IdleWindow }).window;
  if (win !== undefined) refreshIdleOn(win, systemClock)();
}

/** The page's one scheduler over `win`, created on first use. Internal: tests inject `win`/`clock`. */
export function refreshIdleOn(win: IdleWindow, clock: Pick<Clock, 'monotonic'>): () => void {
  const host = win as StateHost;
  const existing = host[KEY];
  if (existing !== undefined) return existing.schedule;
  if (win.__xNavigation === undefined) return (): void => {};
  const doc = win.document;
  const state: IdleState = {
    running: false,
    owed: false,
    timer: undefined,
    // Far enough back that a page nobody touched is quiet from the start.
    lastInput: clock.monotonic() - QUIET_MS,
    pressedAt: undefined,
    schedule: (): void => {
      if (sessionIsLost()) return;
      state.owed = true;
      pump();
    },
  };

  /** Milliseconds until it is worth asking again; `0` = free now; `Infinity` = wait for an event. */
  const heldFor = (): number => {
    if (doc.visibilityState === 'hidden') return Number.POSITIVE_INFINITY;
    const now = clock.monotonic();
    if (state.pressedAt !== undefined && now - state.pressedAt < PRESS_HOLD_MS) {
      return Math.min(QUIET_MS, PRESS_HOLD_MS - (now - state.pressedAt));
    }
    const quiet = QUIET_MS - (now - state.lastInput);
    if (quiet > 0) return quiet;
    return busy() ? QUIET_MS : 0;
  };

  const busy = (): boolean => {
    if (doc.documentElement.hasAttribute('data-x-navigating')) return true;
    if (doc.querySelector('dialog[open]') !== null || popoverOpen()) return true;
    const active = doc.activeElement as (Element & { isContentEditable?: boolean }) | null;
    if (active !== null && active !== doc.body) {
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return true;
      if (active.isContentEditable === true) return true;
    }
    return win.getSelection()?.isCollapsed === false;
  };

  const popoverOpen = (): boolean => {
    try {
      return doc.querySelector('[popover]:popover-open') !== null;
    } catch {
      // A browser without the Popover API cannot parse the pseudo-class, and has no open popover.
      return false;
    }
  };

  const pump = (): void => {
    if (!state.owed || state.running || sessionIsLost()) return;
    win.clearTimeout(state.timer);
    state.timer = undefined;
    const wait = heldFor();
    if (wait === Number.POSITIVE_INFINITY) return;
    if (wait > 0) {
      state.timer = win.setTimeout(pump, wait);
      return;
    }
    state.owed = false;
    state.running = true;
    const router = win.__xNavigation;
    const done = (ran: boolean): void => {
      state.running = false;
      if (ran) {
        pump();
        return;
      }
      // Skipped — a navigation in flight, an open modal, the visitor busy when the answer landed:
      // still owed, and asked again after a quiet second rather than spun on at once.
      state.owed = true;
      state.timer = win.setTimeout(pump, QUIET_MS);
    };
    if (router === undefined) done(true);
    // A failed refresh is not retried here: the router already handed the visitor its own answer.
    else router.refresh(() => heldFor() > 0).then(done, () => done(true));
  };

  const input = (): void => {
    state.lastInput = clock.monotonic();
  };
  const passive = { passive: true, capture: true };
  for (const type of ['scroll', 'wheel', 'keydown']) win.addEventListener(type, input, passive);
  win.addEventListener(
    'pointerdown',
    () => {
      input();
      state.pressedAt = clock.monotonic();
    },
    passive,
  );
  const release = (): void => {
    input();
    state.pressedAt = undefined;
  };
  win.addEventListener('pointerup', release, passive);
  win.addEventListener('pointercancel', release, passive);
  doc.addEventListener('visibilitychange', pump);
  Object.defineProperty(host, KEY, { value: state, configurable: true });
  return state.schedule;
}
