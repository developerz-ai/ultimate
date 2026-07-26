// Guards the one-source-of-truth rule: the SCSS partials are canonical, so if
// tokens.ts drifts from them this fails — which is what `x verify` reports.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import {
  assertColorRole,
  breakpointTokens,
  COLOR_ROLES,
  color,
  colorRgb,
  colorTokens,
  durationTokens,
  fontWeightTokens,
  lineHeightTokens,
  radiusTokens,
  shadowTokens,
  spaceTokens,
  zTokens,
} from './tokens';

const here = new URL('.', import.meta.url).pathname;

async function scss(file: string): Promise<string> {
  return await Bun.file(`${here}${file}`).text();
}

/** Extract a flat `$name: ( key: value, ... );` map from SCSS source text. */
function parseScssMap(source: string, name: string): Record<string, string> {
  const block = new RegExp(`\\$${name}:\\s*\\(([\\s\\S]*?)\\n\\);`).exec(source);
  if (!block?.[1]) throw new Error(`map $${name} not found in SCSS source`);
  const out: Record<string, string> = {};
  for (const raw of block[1].split('\n')) {
    const line = raw
      .replace(/\/\/.*$/, '')
      .trim()
      .replace(/,$/, '');
    if (!line) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function mirror(record: Readonly<Record<string, string>>): Record<string, string> {
  return { ...record };
}

describe('SCSS <-> TS token parity', () => {
  test('colour roles and channels match _colors.scss exactly', async () => {
    const source = await scss('_colors.scss');
    expect(parseScssMap(source, 'light')).toEqual(mirror(colorTokens.light));
    expect(parseScssMap(source, 'dark')).toEqual(mirror(colorTokens.dark));
  });

  test('every declared role appears in both themes', () => {
    for (const role of COLOR_ROLES) {
      expect(colorTokens.light[role]).toMatch(/^\d+ \d+ \d+$/);
      expect(colorTokens.dark[role]).toMatch(/^\d+ \d+ \d+$/);
    }
    expect(Object.keys(colorTokens.light)).toEqual([...COLOR_ROLES]);
  });

  test('scale maps match their SCSS partials', async () => {
    expect(parseScssMap(await scss('_space.scss'), 'space')).toEqual(mirror(spaceTokens));
    expect(parseScssMap(await scss('_radius.scss'), 'radius')).toEqual(mirror(radiusTokens));
    expect(parseScssMap(await scss('_z.scss'), 'z')).toEqual(mirror(zTokens));
    expect(parseScssMap(await scss('_motion.scss'), 'duration')).toEqual(mirror(durationTokens));
    expect(parseScssMap(await scss('_breakpoints.scss'), 'breakpoints')).toEqual(
      mirror(breakpointTokens),
    );
    const type = await scss('_typography.scss');
    expect(parseScssMap(type, 'font-weight')).toEqual(mirror(fontWeightTokens));
    expect(parseScssMap(type, 'line-height')).toEqual(mirror(lineHeightTokens));
  });

  test('shadows differ per theme so dark elevation stays visible', async () => {
    const source = await scss('_shadow.scss');
    expect(parseScssMap(source, 'shadow-light')).toEqual(mirror(shadowTokens.light));
    expect(parseScssMap(source, 'shadow-dark')).toEqual(mirror(shadowTokens.dark));
    for (const rung of Object.keys(shadowTokens.light)) {
      expect(shadowTokens.dark[rung]).not.toBe(shadowTokens.light[rung]);
    }
  });

  test('every colour role is used through a custom property, never inlined', async () => {
    // A raw hex anywhere outside the canonical channel maps is a lint failure.
    for (const file of ['_mixins.scss', 'reset.scss', 'theme.scss']) {
      expect(await scss(file)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe('token helpers', () => {
  test('color() composites alpha off the same channel token', () => {
    expect(color('bg')).toBe('rgb(var(--color-bg) / 1)');
    expect(color('accent', 0.25)).toBe('rgb(var(--color-accent) / 0.25)');
  });

  test('colorRgb() resolves per theme for canvas and email consumers', () => {
    expect(colorRgb('light', 'bg')).toBe('rgb(253 246 240)');
    expect(colorRgb('dark', 'bg')).toBe('rgb(18 18 20)');
    expect(colorRgb('dark', 'accent', 0.4)).toBe('rgb(96 170 240 / 0.4)');
  });

  test('an unknown role throws X_TOKEN_UNKNOWN with a fix', () => {
    try {
      assertColorRole('brand-blue-500');
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; fix?: string };
      expect(err.code).toBe(UI_ERROR_CODES.tokenUnknown);
      expect(err.fix).toContain('_colors.scss');
    }
  });
});
