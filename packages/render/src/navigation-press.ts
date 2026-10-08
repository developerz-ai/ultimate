/**
 * The client router's press bookkeeping: between a press and its click (the focus a press gives a
 * link is not a hover), and the view transition still painting — whose overlay swallows a click,
 * which is given back to the element under the pointer. Split from `navigation.ts` so that file is
 * the controller and nothing else.
 */

import type { RunningTransition } from './navigation-dom';

export interface PressTracker {
  /** Between a press and its click. */
  pressed(): boolean;
  /** `transition`'s `track`: the running transition, forgotten by identity once it finishes. */
  track(running: RunningTransition, finished: boolean): void;
  onPress(): void;
  onRelease(): void;
  /**
   * True when `event` is a click the transition overlay swallowed: the transition is skipped and
   * the click re-aimed at the element under the pointer, and the caller has nothing left to do.
   */
  overlayClick(event: MouseEvent): boolean;
}

export function pressTracker(doc: Document): PressTracker {
  let animating: RunningTransition | undefined;
  let pressed = false;
  /** The press landed while a transition was painting over the page. */
  let pressedOverTransition = false;
  return {
    pressed: () => pressed,
    track(running, finished) {
      if (!finished) animating = running;
      else if (animating === running) animating = undefined;
    },
    onPress() {
      pressed = true;
      // A press alone never skips the running transition — that snapped every named element to
      // its end mid-glide (#621); only the click it becomes may.
      pressedOverTransition = animating !== undefined;
    },
    onRelease() {
      pressed = false;
    },
    // While a view transition paints, the browser hit-tests every press to `<html>` — Chrome does
    // so whatever `pointer-events` the `::view-transition` overlay has — so the click reached
    // nothing: the visitor's first click after a swap was lost. It is given to the element under
    // the pointer, whatever it is: a link, a submit button, an island's own control. Only a
    // skipped transition hit-tests the page, so the skip happens at the click, never at the
    // press; when the animation already ended between the two, there is nothing to skip.
    overlayClick(event) {
      if (!pressedOverTransition || event.target !== doc.documentElement) return false;
      pressedOverTransition = false;
      animating?.skipTransition?.();
      const hit = doc.elementFromPoint(event.clientX, event.clientY);
      if (hit !== null && hit !== doc.documentElement && hit instanceof HTMLElement) hit.click();
      return true;
    },
  };
}
