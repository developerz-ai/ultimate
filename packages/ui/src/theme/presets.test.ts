// A preset is a palette the framework SHIPS, so it is held to exactly the bar the default palette
// is: every pairing in `CONTRAST_PAIRS`, both themes, measured on the preset alone — no shipped
// role to fall back on — plus the chart series' colour-blind floor and the scrim rule.

import { describe, expect, test } from 'bun:test';
import { CHART_DISTINCT_MIN, closestChartPair } from '../tokens/colour-vision';
import { contrastRatio, relativeLuminance } from '../tokens/contrast';
import { CONTRAST_PAIRS } from '../tokens/contrast-pairs';
import { CHART_ROLES, COLOR_ROLES, SHADOW_NAMES, type Theme } from '../tokens/tokens';
import { THEME_PRESETS, type ThemePresetName } from './presets';

const THEMES: readonly Theme[] = ['light', 'dark'];
const NAMES = Object.keys(THEME_PRESETS) as ThemePresetName[];

describe('THEME_PRESETS', () => {
  test('ships scifi, and nothing it does not test', () => {
    expect(NAMES).toEqual(['scifi']);
  });

  test('each preset states every colour role in both themes — it never leans on the default', () => {
    for (const name of NAMES) {
      for (const theme of THEMES) {
        expect(Object.keys(THEME_PRESETS[name].colors[theme])).toEqual([...COLOR_ROLES]);
      }
    }
  });

  test('every pairing a shipped component renders clears WCAG 2.2 AA, both themes', () => {
    const failures = NAMES.flatMap((name) =>
      THEMES.flatMap((theme) => {
        const palette = THEME_PRESETS[name].colors[theme];
        return CONTRAST_PAIRS.flatMap((pair) => {
          const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
          return ratio >= pair.minimum
            ? []
            : [
                `${name}.${theme}: ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}, needs ${pair.minimum}`,
              ];
        });
      }),
    );
    expect(failures).toEqual([]);
  });

  test('the chart series stay apart under every simulated colour vision', () => {
    const failures = NAMES.flatMap((name) =>
      THEMES.flatMap((theme) => {
        const palette = CHART_ROLES.map((role) => THEME_PRESETS[name].colors[theme][role]);
        const closest = closestChartPair(palette);
        return closest.distance >= CHART_DISTINCT_MIN
          ? []
          : [`${name}.${theme}: chart-${closest.a + 1}/chart-${closest.b + 1} (${closest.vision})`];
      }),
    );
    expect(failures).toEqual([]);
  });

  test('the scrim is the darkest role, so a backdrop recedes', () => {
    for (const name of NAMES) {
      for (const theme of THEMES) {
        const palette = THEME_PRESETS[name].colors[theme];
        const scrim = relativeLuminance(palette.scrim);
        const darker = COLOR_ROLES.filter((role) => relativeLuminance(palette[role]) < scrim);
        expect(`${name}.${theme}: ${darker.join(',')}`).toBe(`${name}.${theme}: `);
      }
    }
  });

  test('scifi is deep in the dark: the page is near-black, and the accent is cyan', () => {
    const dark = THEME_PRESETS.scifi.colors.dark;
    expect(relativeLuminance(dark.bg)).toBeLessThan(0.005);
    const [r = 0, g = 0, b = 0] = dark.accent.split(' ').map(Number);
    // Cyan: blue and green both high, red well under them.
    expect(Math.min(g, b) - r).toBeGreaterThan(120);
  });

  test('its shadows are known rungs, and its dark rungs glow from the accent', () => {
    const shadows = THEME_PRESETS.scifi.shadows;
    for (const theme of THEMES) {
      for (const name of Object.keys(shadows?.[theme] ?? {})) {
        expect(SHADOW_NAMES as readonly string[]).toContain(name);
      }
    }
    expect(shadows?.dark?.md).toContain('var(--color-accent)');
  });
});
