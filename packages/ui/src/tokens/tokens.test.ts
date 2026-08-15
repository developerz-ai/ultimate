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

  /**
   * EVERY stylesheet this package ships, not a hand-listed three. Biome ignores `.scss` entirely
   * (`bunx biome check packages/ui/src/global.scss` answers "these paths were provided but
   * ignored"), so this test is the only enforcement of the no-raw-colours rule in the repo — and
   * it used to name `_mixins.scss`, `reset.scss` and `theme.scss` and nothing else, which is none
   * of the 51 component stylesheets a raw hex would actually break theming in.
   *
   * The two exemptions are the canonical sources a literal is *supposed* to live in: the channel
   * triples every role resolves through, and the elevation ramp, which is per-theme by
   * construction and has no role to point at.
   */
  const CANONICAL_COLOUR_FILES = new Set(['tokens/_colors.scss', 'tokens/_shadow.scss']);

  /** A hex literal, or a colour function called with numbers instead of `var(--color-…)`. */
  const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]/;

  const stylesheets = async (): Promise<readonly string[]> => {
    const root = `${here}..`;
    const found: string[] = [];
    for await (const path of new Bun.Glob('**/*.scss').scan({ cwd: root, absolute: false })) {
      found.push(path.split('\\').join('/'));
    }
    return found.sort();
  };

  test('every colour role is used through a custom property, never inlined', async () => {
    const files = await stylesheets();
    // A glob that found nothing would pass forever — the failure mode this test exists to prevent.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('components/Button.module.scss');
    const offenders: string[] = [];
    for (const path of files) {
      if (CANONICAL_COLOUR_FILES.has(path)) continue;
      if (RAW_COLOUR.test(await Bun.file(`${here}../${path}`).text())) offenders.push(path);
    }
    expect(offenders).toEqual([]);
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
