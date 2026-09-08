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
import { CONTRAST_PAIRS, VISIBLE_EDGE } from './contrast-pairs';
import { COLOR_ROLES, type ColorRole, colorTokens, type Theme } from './tokens';

const THEMES: readonly Theme[] = ['light', 'dark'];
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
  /**
   * Driven by `CONTRAST_PAIRS`, which is SOURCE and not a copy of it: `defineTheme()` measures an
   * app's brand against that same list, so the framework's palette and every app's are held to one
   * contract. The table lived in this file until 2026-09, where nothing but a test could read it.
   */
  test('every pairing a shipped component renders, in both themes', () => {
    const failures = THEMES.flatMap((theme) =>
      CONTRAST_PAIRS.filter((pair) => roleContrast(theme, pair.fg, pair.bg) < pair.minimum).map(
        (pair) =>
          `${theme}: ${pair.fg} on ${pair.bg} (${pair.what}) = ${roleContrast(theme, pair.fg, pair.bg).toFixed(2)}, needs ${pair.minimum}`,
      ),
    );
    expect(failures).toEqual([]);
  });

  test('the table is not vacuous — it covers text, fills, tints, the ring and the edge', () => {
    // Two empty lists are equal, so the assertion above passes for a table that lost its rows.
    expect(CONTRAST_PAIRS.length).toBeGreaterThan(40);
    expect(new Set(CONTRAST_PAIRS.map((pair) => pair.minimum))).toEqual(
      new Set([AA_TEXT, AA_LARGE, VISIBLE_EDGE]),
    );
    // Every row says what it IS: a refusal naming two role names explains nothing to the author.
    expect(CONTRAST_PAIRS.filter((pair) => pair.what === '')).toEqual([]);
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
