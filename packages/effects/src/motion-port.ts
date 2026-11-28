// The motion port every mount takes (`frameLoop`, `motionAllowed`, `onMotionChange`), so a test
// drives frames by hand and the four stop reasons (reduced motion, hidden tab, offscreen, the
// `MotionToggle` pause) stay `frameLoop`'s, never re-implemented here. A tick reads its own clock
// and a change re-reads `motionAllowed()`, so nothing here depends on what either callback carries.

import { frameLoop, motionAllowed, onMotionChange } from '@ultimat3/ui/motion';

export interface MotionPort {
  /** Calls `tick` once per frame while `el` may animate; the answer stops it for good. */
  readonly loop: (tick: () => void, el: Element) => () => void;
  readonly allowed: () => boolean;
  /** Calls `listener` when the answer of `allowed()` may have changed; the answer unsubscribes. */
  readonly onChange: (listener: () => void) => () => void;
}

export function browserMotion(): MotionPort {
  return {
    loop: (tick, el) => frameLoop(() => tick(), { el }),
    allowed: () => motionAllowed(),
    onChange: (listener) => onMotionChange(() => listener()),
  };
}
