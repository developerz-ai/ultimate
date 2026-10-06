// The presets `defineTheme({ preset })` accepts. A preset is a BASE the app's own overrides layer
// onto, role by role — never a mode with rules of its own — so every check the brand seam makes
// runs over the merged result. Adding one is a row here plus its file; `presets.test.ts` measures
// every row against the full contrast table.

import { SCIFI_PRESET } from './preset-scifi';
import type { ThemePreset } from './preset-shape';

export const THEME_PRESETS = {
  scifi: SCIFI_PRESET,
} as const satisfies Readonly<Record<string, ThemePreset>>;

export type ThemePresetName = keyof typeof THEME_PRESETS;

export const THEME_PRESET_NAMES = Object.keys(THEME_PRESETS) as readonly ThemePresetName[];
