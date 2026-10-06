// `defineTheme()`'s two newer slots: a preset the app's overrides layer onto, and themed shadows.
// The preset is a BASE, not a mode — every rule the brand seam already enforces (contrast,
// validation, specificity, byte-stable output) holds over the merged result.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { shadowTokens } from '../tokens/tokens';
import { type BrandInput, defineTheme } from './brand';
import { THEME_PRESETS } from './presets';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** The declarations one selector's block carries, in order. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {\n`);
  if (start === -1) return expect.unreachable(`no ${selector} block in the stylesheet`);
  return css.slice(start, css.indexOf('\n}', start));
}

describe('defineTheme({ preset })', () => {
  const scifi = THEME_PRESETS.scifi;

  test('the preset alone renders its palette at every level theme.scss emits', () => {
    const css = defineTheme({ preset: 'scifi' }).css;
    expect(block(css, "html[data-theme='dark']")).toContain(`--color-bg: ${scifi.colors.dark.bg};`);
    expect(block(css, "html[data-theme='light']")).toContain(
      `--color-bg: ${scifi.colors.light.bg};`,
    );
    expect(css).toContain(
      `@media (prefers-color-scheme: dark) {\n  :root {\n    --color-bg: ${scifi.colors.dark.bg};`,
    );
    expect(block(css, ':root')).toContain(`--color-accent: ${scifi.colors.light.accent};`);
    expect(block(css, ':root')).toContain('--radius-md: ');
  });

  test('an override layers onto the preset, role by role — the rest of the preset stays', () => {
    const css = defineTheme({
      preset: 'scifi',
      colors: { dark: { 'chart-1': '120 220 255' } },
    }).css;
    const dark = block(css, "html[data-theme='dark']");
    expect(dark).toContain('--color-chart-1: 120 220 255;');
    expect(dark).not.toContain(`--color-chart-1: ${scifi.colors.dark['chart-1']};`);
    expect(dark).toContain(`--color-accent: ${scifi.colors.dark.accent};`);
  });

  test('an override is measured against the PRESET it lands on, not the shipped palette', () => {
    // A grey caption that is too dim for the shipped warm-dark cards and reads on scifi's deeper
    // ones: one value, two verdicts, decided by the base it is layered onto.
    const caption = { dark: { 'fg-muted': '135 135 140' } } as const;
    expect(codeOf(() => defineTheme({ colors: caption }))).toBe(
      UI_ERROR_CODES.contrastInsufficient,
    );
    expect(codeOf(() => defineTheme({ preset: 'scifi', colors: caption }))).toBeUndefined();
    // …and the merged palette is measured in full: a mid-grey page under scifi's pale text fails.
    expect(
      codeOf(() => defineTheme({ preset: 'scifi', colors: { dark: { bg: '120 120 130' } } })),
    ).toBe(UI_ERROR_CODES.contrastInsufficient);
  });

  test('an override spelled `undefined` is no override — the preset value stays', () => {
    // A spread would copy the `undefined` over the preset's accent, and the stylesheet would then
    // say nothing about accent at all: the shipped blue on scifi's near-black page.
    // The type forbids it under `exactOptionalPropertyTypes`; a JS caller, or a config object built
    // by spreading optional fields, does not.
    const input = { preset: 'scifi', colors: { dark: { accent: undefined } } } as unknown;
    const css = defineTheme(input as BrandInput).css;
    expect(block(css, "html[data-theme='dark']")).toContain(
      `--color-accent: ${scifi.colors.dark.accent};`,
    );
  });

  test('the output is byte-stable — a preset rendered twice is one CSP hash', () => {
    expect(defineTheme({ preset: 'scifi' }).css).toBe(defineTheme({ preset: 'scifi' }).css);
  });

  test('a preset the package does not ship is refused, from a JSON config too', () => {
    const fromJson = JSON.parse('{"preset":"cyberpunk"}') as { preset: 'scifi' };
    expect(codeOf(() => defineTheme(fromJson))).toBe(UI_ERROR_CODES.invalidValue);
    // Own properties only: an inherited name is not a preset.
    const inherited = JSON.parse('{"preset":"toString"}') as { preset: 'scifi' };
    expect(codeOf(() => defineTheme(inherited))).toBe(UI_ERROR_CODES.invalidValue);
    // @ts-expect-error 'neon' is not a ThemePresetName
    expect(codeOf(() => defineTheme({ preset: 'neon' }))).toBe(UI_ERROR_CODES.invalidValue);
  });
});

describe('defineTheme({ shadows })', () => {
  test('a light shadow lands at :root and html[data-theme="light"]; dark media keeps shipped', () => {
    const css = defineTheme({ shadows: { light: { md: '0 4px 14px rgb(10 20 30 / 0.2)' } } }).css;
    expect(block(css, ':root')).toContain('--shadow-md: 0 4px 14px rgb(10 20 30 / 0.2);');
    expect(block(css, "html[data-theme='light']")).toContain(
      '--shadow-md: 0 4px 14px rgb(10 20 30 / 0.2);',
    );
    expect(css).toContain(
      `@media (prefers-color-scheme: dark) {\n  :root {\n    --shadow-md: ${shadowTokens.dark.md};`,
    );
    expect(css).not.toContain("html[data-theme='dark']");
  });

  test('a role-tinted, multi-layer and inset shadow are all shadow values', () => {
    const css = defineTheme({
      shadows: {
        dark: {
          'glow-md': '0 0 14px rgb(var(--color-accent) / 0.5)',
          sm: 'inset 0 0 0 1px rgb(var(--color-line) / 0.4), 0 2px 8px rgb(0 0 0 / 0.5)',
          xs: 'none',
        },
      },
    }).css;
    const dark = block(css, "html[data-theme='dark']");
    // Canonical rung order, not the input's.
    expect(dark).toBe(
      "html[data-theme='dark'] {\n" +
        '  --shadow-xs: none;\n' +
        '  --shadow-sm: inset 0 0 0 1px rgb(var(--color-line) / 0.4), 0 2px 8px rgb(0 0 0 / 0.5);\n' +
        '  --shadow-glow-md: 0 0 14px rgb(var(--color-accent) / 0.5);',
    );
  });

  test('an unknown rung is X_TOKEN_UNKNOWN naming _shadow.scss', () => {
    // @ts-expect-error 'huge' is not a ShadowName
    const run = () => defineTheme({ shadows: { light: { huge: 'none' } } });
    expect(codeOf(run)).toBe(UI_ERROR_CODES.tokenUnknown);
    try {
      run();
    } catch (error) {
      expect((error as { fix?: string }).fix).toContain('_shadow.scss');
    }
  });

  test('anything that is not a shadow value is refused, never escaped', () => {
    const bad = [
      '0 4px 14px red',
      '0 4px 14px #000',
      '0 4px rgb(0 0 0 / 0.2)}',
      '0 4px 14px rgb(var(--color-brand) / 0.2)',
      '0 4px 14px rgb(0 0 0 / 0.2); } html { display: none',
      '0 4px 14px rgb(0 0 0 / 0.2)</style><script>',
      'calc(1px) 0 0 rgb(0 0 0)',
      '0 4px 14px rgb(300 0 0)',
      '',
    ];
    for (const value of bad) {
      expect(`${value} → ${codeOf(() => defineTheme({ shadows: { light: { md: value } } }))}`).toBe(
        `${value} → ${UI_ERROR_CODES.invalidValue}`,
      );
    }
  });
});

describe('defineTheme({ font: { data } })', () => {
  test('the data slot is a font slot like sans and mono', () => {
    expect(defineTheme({ font: { data: "'IBM Plex Mono', monospace" } }).css).toBe(
      ":root {\n  --font-data: 'IBM Plex Mono', monospace;\n}",
    );
  });
});
