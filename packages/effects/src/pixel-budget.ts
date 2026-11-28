// How many device pixels an effect canvas may draw: one token for the DPR floor, the DPR cap and
// the pixel ceiling, so a 3x phone and a 5K monitor pay a bounded fill rate and no entry picks its
// own numbers. A shader's cost is per pixel; the ceiling is what keeps a full-bleed hero cheap.

export interface PixelBudget {
  /** The lowest ratio drawn: a zoomed-out page (ratio < 1) still draws crisp. */
  readonly dprFloor: number;
  /** The highest ratio drawn: past 2x the eye gains nothing a gradient can show. */
  readonly dprCap: number;
  /** Backing-store pixels, width x height. Wins over the floor: a 5K canvas draws under 1x. */
  readonly maxPixelCount: number;
}

export const EFFECT_PIXELS: PixelBudget = Object.freeze({
  dprFloor: 1,
  dprCap: 2,
  maxPixelCount: 1920 * 1080 * 2,
});

export interface BackingSize {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** The backing-store size for a box of `cssWidth` x `cssHeight` CSS pixels. Never 0 wide. */
export function backingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  budget: PixelBudget = EFFECT_PIXELS,
): BackingSize {
  const ratio = Number.isFinite(devicePixelRatio) ? devicePixelRatio : budget.dprFloor;
  let scale = Math.min(budget.dprCap, Math.max(budget.dprFloor, ratio));
  const area = cssWidth * cssHeight * scale * scale;
  if (area > budget.maxPixelCount) scale = Math.sqrt(budget.maxPixelCount / (cssWidth * cssHeight));
  return {
    width: Math.max(1, Math.floor(cssWidth * scale)),
    height: Math.max(1, Math.floor(cssHeight * scale)),
    scale,
  };
}
