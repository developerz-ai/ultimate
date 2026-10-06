// What a theme preset IS: a complete palette for both themes plus optional shadow, radius and font
// overrides — the same slots `defineTheme()` takes, with colours made total so a preset is measured
// alone and never leans on the default palette to pass.

import type { ColorRole, RadiusName, ShadowName, Theme } from '../tokens/tokens';

/** The font slots `_typography.scss` emits — `defineTheme()` validates against this list. */
export const FONT_SLOTS = ['sans', 'mono', 'data'] as const;
export type FontSlot = (typeof FONT_SLOTS)[number];

export interface ThemePreset {
  readonly colors: Readonly<Record<Theme, Readonly<Record<ColorRole, string>>>>;
  readonly shadows?: Readonly<
    Partial<Record<Theme, Readonly<Partial<Record<ShadowName, string>>>>>
  >;
  readonly radius?: Readonly<Partial<Record<RadiusName, string>>>;
  readonly font?: Readonly<Partial<Record<FontSlot, string>>>;
}
