// Where the spotlight sits: the pointer inside the card, or the focused control's centre for a
// keyboard user, so both inputs light the same highlight. Pure geometry; the DOM wiring is the
// component's.

export const SPOTLIGHT_BACKEND = 'static';

export interface SpotlightBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SpotlightPoint {
  readonly x: number;
  readonly y: number;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/** The pointer relative to the card's box, held inside it (a drag can leave the card). */
export function spotlightPoint(
  box: SpotlightBox,
  clientX: number,
  clientY: number,
): SpotlightPoint {
  return { x: clamp(clientX - box.left, box.width), y: clamp(clientY - box.top, box.height) };
}

/** The centre of `target` expressed in the card's own coordinates: what keyboard focus lights. */
export function spotlightFocusPoint(card: SpotlightBox, target: SpotlightBox): SpotlightPoint {
  return spotlightPoint(card, target.left + target.width / 2, target.top + target.height / 2);
}

export function spotlightVars(point: SpotlightPoint): Readonly<Record<string, string>> {
  return { '--spot-x': `${Math.round(point.x)}px`, '--spot-y': `${Math.round(point.y)}px` };
}
