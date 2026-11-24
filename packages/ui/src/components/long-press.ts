// A touch press held still long enough is a long press: on a board card it ticks the card's
// selection box, the touch form of a click on it. Pure over an injected timer, so a test holds and
// lifts a finger with no clock; the binder that wires it to pointer events is `bindLongPress`.

import { DRAG_THRESHOLD_PX, type DragPoint } from '../drag/pointer-drag';

/** How long a finger rests before a press is a long press — the platforms' own figure. */
export const LONG_PRESS_MS = 500;

/** Schedules `fn` once and answers the function that cancels it. */
export type LongPressTimer = (fn: () => void, ms: number) => () => void;

export interface LongPress {
  down(point: DragPoint): void;
  /** Travel past the drag threshold is a scroll or a drag, never a long press. */
  move(point: DragPoint): void;
  up(): void;
  /** Another kind of press began: nothing is held, and nothing fired. */
  reset(): void;
  /** Whether the press that just ended fired, so the click it is about to send can be swallowed. */
  fired(): boolean;
}

export function longPress(
  onLongPress: () => void,
  timer: LongPressTimer,
  ms = LONG_PRESS_MS,
): LongPress {
  let cancel = (): void => {};
  let origin: DragPoint | null = null;
  let fired = false;
  const stop = (): void => {
    if (origin !== null) cancel();
    origin = null;
  };
  return {
    down(point) {
      stop();
      fired = false;
      origin = point;
      cancel = timer(() => {
        origin = null;
        fired = true;
        onLongPress();
      }, ms);
    },
    move(point) {
      if (origin === null) return;
      if (Math.hypot(point.x - origin.x, point.y - origin.y) >= DRAG_THRESHOLD_PX) stop();
    },
    up: stop,
    reset() {
      stop();
      fired = false;
    },
    fired: () => fired,
  };
}

/** Only a touch press is watched: a mouse has Shift+click and a pen has its own hover. */
export function bindLongPress(el: HTMLElement, onLongPress: () => void): void {
  const press = longPress(onLongPress, (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  });
  const at = (event: PointerEvent): DragPoint => ({ x: event.clientX, y: event.clientY });
  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') press.down(at(event));
    else press.reset();
  });
  el.addEventListener('pointermove', (event) => press.move(at(event)));
  el.addEventListener('pointerup', () => press.up());
  el.addEventListener('pointercancel', () => press.up());
  // The held finger opens the browser's own menu on a link or an image; the press already acted.
  el.addEventListener('contextmenu', (event) => {
    if (press.fired()) event.preventDefault();
  });
  el.addEventListener(
    'click',
    (event) => {
      if (!press.fired()) return;
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );
}
