// Colour for a canvas or a shader, read from the RESOLVED role tokens on the element — the same
// `--color-<role>` channels the stylesheet's `t.role()` reads, so a brand, a preset and dark mode
// recolour every backend at once and no entry carries a colour literal.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectHost } from './effect-host';

/** One colour, each channel 0..1. */
export type Rgb = readonly [number, number, number];

/** `"12 34 56"` (the token's channel form) → 0..1 channels; anything else is `undefined`. */
export function parseChannels(text: string): Rgb | undefined {
  const parts = text.trim().split(/[\s,]+/);
  if (parts.length !== 3) return undefined;
  const channels = parts.map(Number);
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255))
    return undefined;
  const [r = 0, g = 0, b = 0] = channels;
  return [r / 255, g / 255, b / 255];
}

/** Every role resolved on `el`, or `undefined` when one is unset (no theme stylesheet loaded). */
export function resolvePalette(
  host: EffectHost,
  el: Element,
  roles: readonly ColorRole[],
): readonly Rgb[] | undefined {
  const colours: Rgb[] = [];
  for (const role of roles) {
    const colour = parseChannels(host.readVar(el, `--color-${role}`));
    if (colour === undefined) return undefined;
    colours.push(colour);
  }
  return colours;
}

/** A canvas fill for `colour` at `alpha`: built from resolved channels, never authored. */
export function cssRgb(colour: Rgb, alpha = 1): string {
  const [r, g, b] = colour.map((channel) => Math.round(channel * 255));
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}
