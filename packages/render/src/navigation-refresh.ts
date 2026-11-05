/**
 * What makes a `refresh()` a refresh: the same page for the same visitor. Its swap runs without a
 * view transition, leaves focus on the control the visitor was in and announces nothing; a
 * navigation already in flight is never cancelled for it. `navigation.ts` asks these at each step.
 */

import { type FocusMark, focusMain, markFocus, restoreFocus, transition } from './navigation-dom';

/**
 * One `refresh()` in flight: `held` is asked again at the swap — the visitor may have started
 * typing or opened a dialog while the page was fetched — and `landed` is what `refresh()` answers.
 */
export interface RefreshRun {
  readonly held: (() => boolean) | undefined;
  landed: boolean;
}

/** Held across a refresh's swap: where focus was. `undefined` for an ordinary navigation. */
export type RefreshHold = { readonly mark: FocusMark | null; readonly run: RefreshRun } | undefined;

/**
 * Taken at the swap, while the focused control is still in the document. `null`: the refresh is
 * held NOW, so nothing is swapped and `refresh()` answers `false` for its caller to owe it again.
 */
export function holdFor(doc: Document, run: RefreshRun | undefined): RefreshHold | null {
  if (run === undefined) return undefined;
  return run.held?.() === true ? null : { mark: markFocus(doc), run };
}

/**
 * Whether this navigation is skipped: a refresh while another navigation is in flight. That one
 * fetches fresh anyway, and aborting it is how a visitor's click was lost.
 */
export function refreshYields(refresh: RefreshRun | undefined, inflight: unknown): boolean {
  return refresh !== undefined && inflight !== undefined;
}

/** The swap: a view transition for a new place, a plain call for the same page. */
export function swapIn(
  win: Window,
  hold: RefreshHold,
  apply: () => void,
  track: Parameters<typeof transition>[2],
): Promise<void> {
  if (hold === undefined) return transition(win, apply, track);
  apply();
  return Promise.resolve();
}

/**
 * After the scripts ran, so an island's mounted control is there to take focus back. A new place:
 * `<main>` and the title read out. A refresh: the marked control, and the announcer untouched.
 */
export function landFocus(doc: Document, live: HTMLElement, hold: RefreshHold): void {
  if (hold !== undefined) {
    restoreFocus(doc, hold.mark);
    hold.run.landed = true;
    return;
  }
  focusMain(doc);
  live.textContent = doc.title;
}
