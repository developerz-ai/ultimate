// The palette's accessibility contract, as a build error. Every pairing below is one a shipped
// component actually renders, checked in BOTH themes — a dark theme that merely exists is not the
// claim; a dark theme that reads is. Changing a channel in `_colors.scss` fails here first.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import {
  AA_LARGE,
  AA_TEXT,
  contrastRatio,
  parseChannels,
  relativeLuminance,
  roleContrast,
} from './contrast';
import { COLOR_ROLES, type ColorRole, colorTokens, type Theme } from './tokens';

const THEMES: readonly Theme[] = ['light', 'dark'];
const STATUS = ['success', 'warning', 'danger', 'info'] as const;
const SURFACES: readonly ColorRole[] = ['bg', 'bg-soft', 'surface', 'surface-raised'];

/**
 * The framework's own floor for a 1px edge, not a WCAG level: below it a border is a rumour, and
 * `line` on `surface-raised` in dark measured 1.16 — an input with no visible outline.
 */
const VISIBLE_EDGE = 1.4;

/**
 * Failures are collected, not thrown one at a time: `expect(failures).toEqual([])` names every
 * broken pairing and its measured ratio in one run, which is what an agent needs to fix a palette
 * in one pass instead of re-running the suite per colour.
 */
function belowMinimum(
  pairs: readonly (readonly [Theme, ColorRole, ColorRole])[],
  minimum: number,
): string[] {
  const failures: string[] = [];
  for (const [theme, fg, bg] of pairs) {
    const ratio = roleContrast(theme, fg, bg);
    if (ratio < minimum) {
      failures.push(`${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}, needs ${minimum}`);
    }
  }
  return failures;
}

function everyTheme(
  build: (theme: Theme) => readonly (readonly [ColorRole, ColorRole])[],
): (readonly [Theme, ColorRole, ColorRole])[] {
  return THEMES.flatMap((theme) => build(theme).map(([fg, bg]) => [theme, fg, bg] as const));
}

describe('contrast helpers', () => {
  test('luminance spans the full range', () => {
    expect(relativeLuminance('0 0 0')).toBe(0);
    expect(relativeLuminance('255 255 255')).toBe(1);
  });

  test('black on white is the 21:1 maximum, and the ratio is symmetric', () => {
    expect(contrastRatio('0 0 0', '255 255 255')).toBeCloseTo(21, 5);
    expect(contrastRatio('255 255 255', '0 0 0')).toBeCloseTo(21, 5);
    expect(contrastRatio('31 110 178', '31 110 178')).toBeCloseTo(1, 5);
  });

  test('a malformed channel string is X_UI_INVALID_VALUE, never NaN', () => {
    for (const bad of ['#1e6eb2', '31,110,178', '31 110', '31 110 300', '']) {
      try {
        parseChannels(bad);
        throw new Error(`expected a throw for ${JSON.stringify(bad)}`);
      } catch (error) {
        const err = error as { code?: string };
        expect(err.code).toBe(UI_ERROR_CODES.invalidValue);
      }
    }
  });

  test('parses every shipped channel string in both themes', () => {
    for (const theme of THEMES) {
      for (const role of COLOR_ROLES) {
        expect(parseChannels(colorTokens[theme][role])).toHaveLength(3);
      }
    }
  });
});

describe('every shipped pairing meets WCAG AA in both themes', () => {
  test('body, heading and caption text on every surface', () => {
    const pairs = everyTheme(() =>
      (['fg', 'fg-strong', 'fg-muted'] as const).flatMap((fg) =>
        SURFACES.map((bg) => [fg, bg] as const),
      ),
    );
    expect(belowMinimum(pairs, AA_TEXT)).toEqual([]);
  });

  test('link and accent text on every surface', () => {
    const pairs = everyTheme(() =>
      (['accent', 'accent-strong'] as const).flatMap((fg) =>
        SURFACES.map((bg) => [fg, bg] as const),
      ),
    );
    expect(belowMinimum(pairs, AA_TEXT)).toEqual([]);
  });

  test('text on a solid fill — Button primary, Badge solid', () => {
    const pairs = everyTheme(() => [
      ['accent-fg', 'accent'],
      ['accent-fg', 'accent-strong'],
      ...STATUS.map((status) => [`${status}-fg`, status] as const),
    ]);
    expect(belowMinimum(pairs, AA_TEXT)).toEqual([]);
  });

  test('status text on its own soft tint — Badge soft, Alert, Toast', () => {
    const pairs = everyTheme(() =>
      STATUS.flatMap(
        (status) =>
          [
            [status, `${status}-soft`],
            // Alert renders its body copy as `fg-muted` over the same tint.
            ['fg-muted', `${status}-soft`],
          ] as const,
      ),
    );
    expect(belowMinimum(pairs, AA_TEXT)).toEqual([]);
  });

  test('status text on the page, card and raised surfaces', () => {
    const pairs = everyTheme(() =>
      STATUS.flatMap((status) => SURFACES.map((bg) => [status, bg] as const)),
    );
    expect(belowMinimum(pairs, AA_TEXT)).toEqual([]);
  });

  test('the focus ring is visible against every surface', () => {
    const pairs = everyTheme(() => SURFACES.map((bg) => ['accent', bg] as const));
    expect(belowMinimum(pairs, AA_LARGE)).toEqual([]);
  });

  test('borders and dividers clear the visible-edge floor on every surface', () => {
    const pairs = everyTheme(() => SURFACES.map((bg) => ['line', bg] as const));
    expect(belowMinimum(pairs, VISIBLE_EDGE)).toEqual([]);
  });

  // A backdrop is composited at alpha over arbitrary page content, so a ratio against one role
  // says nothing. What must hold is that it is the darkest thing in the palette — a scrim lighter
  // than any surface brightens the page it is meant to recede behind.
  test('the scrim is the darkest role in both themes', () => {
    const brighter = THEMES.flatMap((theme) => {
      const scrim = relativeLuminance(colorTokens[theme].scrim);
      return COLOR_ROLES.filter((role) => relativeLuminance(colorTokens[theme][role]) < scrim).map(
        (role) => `${theme}: ${role} is darker than scrim`,
      );
    });
    expect(brighter).toEqual([]);
  });

  test('the floor is a real bar — an obviously broken pairing is reported', () => {
    expect(belowMinimum([['light', 'fg-muted', 'fg']], AA_TEXT)).toEqual([
      `light: fg-muted on fg = ${roleContrast('light', 'fg-muted', 'fg').toFixed(2)}, needs 4.5`,
    ]);
  });
});
