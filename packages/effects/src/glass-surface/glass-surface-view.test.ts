// The contrast claim, MEASURED: every text pairing the palette promises on `surface` still clears
// its floor once the pane is translucent over the worst backdrops, in both themes.

import { describe, expect, test } from 'bun:test';
import { AA_TEXT, CONTRAST_PAIRS, colorTokens, contrastRatio } from '@ultimat3/ui';
import {
  compositeOver,
  GLASS_BACKDROP_ROLES,
  GLASS_BACKEND,
  GLASS_SURFACE_ALPHA,
  glassAlpha,
} from './glass-surface-view';

describe('compositeOver', () => {
  test('alpha 1 is the top colour, alpha 0 the backdrop', () => {
    expect(compositeOver('10 20 30', 1, '200 200 200')).toBe('10 20 30');
    expect(compositeOver('10 20 30', 0, '200 200 200')).toBe('200 200 200');
  });
});

describe('glass keeps the palette contrast', () => {
  const onSurface = CONTRAST_PAIRS.filter((p) => p.bg === 'surface' && p.minimum >= AA_TEXT);

  test('the contract has pairings to check', () => {
    expect(onSurface.length).toBeGreaterThan(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: every on-surface pair clears its floor over every backdrop role of its own palette`, () => {
      const tokens = colorTokens[theme];
      const failures = onSurface.flatMap((pair) =>
        GLASS_BACKDROP_ROLES.map((role) => {
          const backdrop = tokens[role];
          const pane = compositeOver(tokens.surface, GLASS_SURFACE_ALPHA, backdrop);
          return {
            what: pair.what,
            backdrop,
            ratio: contrastRatio(tokens[pair.fg], pane),
            min: pair.minimum,
          };
        }).filter((m) => m.ratio < m.min),
      );
      expect(failures).toEqual([]);
    });
  }

  test('a far lower alpha WOULD fail somewhere (the check can fail)', () => {
    const tokens = colorTokens.light;
    const pane = compositeOver(tokens.surface, 0.1, '0 0 0');
    expect(contrastRatio(tokens.fg, pane)).toBeLessThan(4.5);
  });

  test('glassAlpha never goes below the measured floor', () => {
    expect(glassAlpha(undefined)).toBe(GLASS_SURFACE_ALPHA);
    expect(glassAlpha(0.2)).toBe(GLASS_SURFACE_ALPHA);
    expect(glassAlpha(Number.NaN)).toBe(GLASS_SURFACE_ALPHA);
    expect(glassAlpha(0.95)).toBe(0.95);
    expect(glassAlpha(3)).toBe(1);
  });

  test('no animation: static tier', () => {
    expect(GLASS_BACKEND).toBe('static');
  });
});
