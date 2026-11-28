// Tilt's rules as pure functions: the angle cap, the angles for a pointer, and when tilt is off
// at all. A tilt that fights a modal's focus trap or a finger's scroll is worse than none.

import { EffectsInvalidValueError } from '../errors';

export const TILT_BACKEND = 'static';
export const TILT_DEFAULT_DEG = 8;
/** The hard ceiling: past this a card stops reading as a surface and starts to smear. */
export const TILT_MAX_DEG = 15;

/** A focus trap's roots: the inert background is the author's, so tilt stays out of them. */
export const FOCUS_TRAP_SELECTOR = 'dialog[open], [aria-modal="true"], [data-focus-trap]';

export interface TiltBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TiltAngles {
  readonly rotateX: number;
  readonly rotateY: number;
}

export interface TiltEnvironment {
  readonly coarsePointer: boolean;
  readonly insideFocusTrap: boolean;
  readonly motionAllowed: boolean;
}

/** The requested max angle, capped. A non-finite or non-positive value is refused, not clamped. */
export function tiltCap(requested: number | undefined): number {
  if (requested === undefined) return TILT_DEFAULT_DEG;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new EffectsInvalidValueError({
      cause: `Tilt maxAngle must be a positive finite number of degrees, got ${String(requested)}.`,
      fix: `<Tilt maxAngle={${TILT_DEFAULT_DEG}} />   // degrees > 0; above ${TILT_MAX_DEG} is capped, or omit maxAngle`,
    });
  }
  return Math.min(requested, TILT_MAX_DEG);
}

const unit = (value: number): number => Math.min(Math.max(value, -1), 1);

/** The pointer's offset from the centre, as a fraction of the half-size, times the cap. */
export function tiltAngles(
  box: TiltBox,
  clientX: number,
  clientY: number,
  cap: number,
): TiltAngles {
  if (box.width <= 0 || box.height <= 0) return { rotateX: 0, rotateY: 0 };
  const nx = unit(((clientX - box.left) / box.width) * 2 - 1);
  const ny = unit(((clientY - box.top) / box.height) * 2 - 1);
  return {
    rotateX: Math.round(-ny * cap * 100) / 100 || 0,
    rotateY: Math.round(nx * cap * 100) / 100 || 0,
  };
}

export function tiltEnabled(env: TiltEnvironment): boolean {
  return env.motionAllowed && !env.coarsePointer && !env.insideFocusTrap;
}
