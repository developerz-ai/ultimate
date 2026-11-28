// The glass recipe as numbers, so the contrast claim is testable: how translucent the pane is and
// what a given backdrop does to its colour. The SCSS reads the same alpha through one token.

export const GLASS_BACKEND = 'static';
/** How much of the surface role shows. Below this, text on a worst-case backdrop leaves AA. */
export const GLASS_SURFACE_ALPHA = 0.82;
export const GLASS_BLUR_PX = 12;

/** `"r g b"` channels (the token format) → numbers. */
const parse = (channels: string): [number, number, number] => {
  const [r = 0, g = 0, b = 0] = channels.split(' ').map(Number);
  return [r, g, b];
};

/** The colour a translucent `top` lays over an opaque `under`: plain source-over, per channel. */
export function compositeOver(top: string, alpha: number, under: string): string {
  const a = parse(top);
  const b = parse(under);
  return a.map((channel, i) => Math.round(channel * alpha + (b[i] ?? 0) * (1 - alpha))).join(' ');
}

/**
 * What glass is measured against: the roles a pane sits on inside one theme. Pure black or white
 * behind it (a photograph) would need alpha ~0.98, which is no longer glass; an app with such a
 * backdrop passes a higher `alpha`, and `glassAlpha` never goes below this floor.
 */
export const GLASS_BACKDROP_ROLES = ['bg', 'bg-soft', 'surface', 'surface-raised', 'line'] as const;

/** The requested opacity of the pane, held to [GLASS_SURFACE_ALPHA, 1]: translucency is a floor. */
export function glassAlpha(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return GLASS_SURFACE_ALPHA;
  return Math.min(Math.max(requested, GLASS_SURFACE_ALPHA), 1);
}
