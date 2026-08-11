// WCAG 2.2 relative luminance and contrast ratio over the canonical channel
// tokens. Here rather than in a review checklist: a palette pairing that fails
// AA is a failing test (`contrast.test.ts`), and a brand override is measured
// with the same function before it ships.

import { invalidValueError } from '../errors';
import { type ColorRole, colorTokens, type Theme } from './tokens';

/** Minimum ratio for body text — WCAG 2.2 AA, 1.4.3. */
export const AA_TEXT = 4.5;

/** Minimum ratio for large text and non-text UI — WCAG 2.2 AA, 1.4.3 / 1.4.11. */
export const AA_LARGE = 3;

/** `R G B`, each 0–255. The only channel spelling the token layer accepts. */
export const CHANNELS_PATTERN = /^\d{1,3} \d{1,3} \d{1,3}$/;

export type Channels = readonly [number, number, number];

/** Parse `"31 110 178"`. Throws `X_UI_INVALID_VALUE` on anything else. */
export function parseChannels(value: string): Channels {
  if (!CHANNELS_PATTERN.test(value)) {
    throw invalidValueError('colour channels', value, 'three space-separated 0–255 integers');
  }
  const parts = value.split(' ').map(Number);
  const [r = 0, g = 0, b = 0] = parts;
  if (r > 255 || g > 255 || b > 255) {
    throw invalidValueError('colour channels', value, 'three space-separated 0–255 integers');
  }
  return [r, g, b];
}

// sRGB → linear, then the ITU-R BT.709 luma weights WCAG specifies.
function linearize(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(channels: string): number {
  const [r, g, b] = parseChannels(channels);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Symmetric — order of the two colours does not change the ratio. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The ratio between two semantic roles as resolved in one theme. */
export function roleContrast(theme: Theme, fg: ColorRole, bg: ColorRole): number {
  return contrastRatio(colorTokens[theme][fg], colorTokens[theme][bg]);
}

export function meetsContrast(
  theme: Theme,
  fg: ColorRole,
  bg: ColorRole,
  minimum: number = AA_TEXT,
): boolean {
  return roleContrast(theme, fg, bg) >= minimum;
}
