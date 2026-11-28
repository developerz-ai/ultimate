// Tilt's pointer handling over an element, host-injected so the motion gate is the port's.

import type { EffectHost } from '../effect-host';
import { FOCUS_TRAP_SELECTOR, tiltAngles, tiltEnabled } from './tilt-view';

export interface TiltTarget {
  closest(selector: string): unknown;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

export interface TiltPointer {
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
}

export function tiltRest(el: TiltTarget): void {
  el.style.removeProperty('--tilt-x');
  el.style.removeProperty('--tilt-y');
}

/** Leans toward the pointer, or lays the element flat when tilt is off for this pointer/page. */
export function tiltMove(
  el: TiltTarget,
  pointer: TiltPointer,
  cap: number,
  host: EffectHost,
): void {
  const on = tiltEnabled({
    coarsePointer: pointer.pointerType !== 'mouse' && pointer.pointerType !== 'pen',
    insideFocusTrap: el.closest(FOCUS_TRAP_SELECTOR) !== null,
    motionAllowed: host.motion.allowed(),
  });
  if (!on) {
    tiltRest(el);
    return;
  }
  const { rotateX, rotateY } = tiltAngles(
    el.getBoundingClientRect(),
    pointer.clientX,
    pointer.clientY,
    cap,
  );
  el.style.setProperty('--tilt-x', `${rotateX}deg`);
  el.style.setProperty('--tilt-y', `${rotateY}deg`);
}
