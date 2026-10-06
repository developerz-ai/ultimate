// The shadow grammar on its own: every rung the package ships is a value it accepts (or a brand
// could never restate one), and every near miss that would escape a `<style>` is not.

import { describe, expect, test } from 'bun:test';
import { SHADOW_NAMES, shadowTokens } from '../tokens/tokens';
import { THEME_PRESETS } from './presets';
import { isShadowValue } from './shadow-value';

describe('isShadowValue', () => {
  test('accepts every shipped rung in both themes, and every preset rung', () => {
    const shipped = (['light', 'dark'] as const).flatMap((theme) =>
      SHADOW_NAMES.map((name) => shadowTokens[theme][name]),
    );
    const preset = Object.values(THEME_PRESETS).flatMap((p) =>
      Object.values(p.shadows ?? {}).flatMap((rungs) => Object.values(rungs ?? {})),
    );
    expect([...shipped, ...preset].filter((value) => !isShadowValue(value))).toEqual([]);
    expect(preset.length).toBeGreaterThan(0);
  });

  test('accepts none, inset, a spread, negatives and several layers', () => {
    for (const value of [
      'none',
      'inset 0 0 0 1px rgb(var(--color-line) / 0.4)',
      '0 -2px 0.5rem 2px rgb(0 0 0 / .5)',
      '0 1px 2px rgb(0 0 0), 0 0 8px rgb(var(--color-chart-2) / 0.3)',
    ]) {
      expect(`${value}: ${isShadowValue(value)}`).toBe(`${value}: true`);
    }
  });

  test('refuses names, hex, unknown roles, out-of-range channels, functions and escapes', () => {
    for (const value of [
      '',
      '0 4px 14px red',
      '0 4px 14px #000',
      '0 4px 14px rgb(var(--color-brand) / 0.2)',
      '0 4px 14px rgb(256 0 0)',
      '0 4px 14px rgb(0 0 0 / 2)',
      'calc(1px) 0 0 rgb(0 0 0)',
      '0 4px 14px var(--x)',
      '4px rgb(0 0 0)',
      '0 4px 14px rgb(0 0 0);}',
      '0 4px 14px rgb(0 0 0)</style>',
      '0 4px 14px rgb(0 0 0),0 0 1px rgb(0 0 0)',
      `${'0 0 1px rgb(0 0 0), '.repeat(30)}0 0 1px rgb(0 0 0)`,
    ]) {
      expect(`${value}: ${isShadowValue(value)}`).toBe(`${value}: false`);
    }
  });
});
