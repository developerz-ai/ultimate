// The brand seam's two jobs: emit at every specificity level `theme.scss` occupies (or the
// override silently loses in a themed document), and refuse anything that is not a token value
// (or `<style>` becomes an injection point).

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { brandStyleCspSource, brandStyleTag, defineTheme } from './brand';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('defineTheme', () => {
  test('an empty brand emits nothing at all', () => {
    expect(defineTheme({}).css).toBe('');
  });

  test('light colours land at both :root and html[data-theme="light"]', () => {
    const css = defineTheme({ colors: { light: { accent: '10 20 30' } } }).css;
    expect(css).toContain(':root {\n  --color-accent: 10 20 30;\n}');
    expect(css).toContain("html[data-theme='light'] {\n  --color-accent: 10 20 30;\n}");
    expect(css).not.toContain('prefers-color-scheme');
  });

  test('dark colours land behind the media query AND the attribute rule', () => {
    const css = defineTheme({ colors: { dark: { accent: '200 210 220' } } }).css;
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root {');
    expect(css).toContain("html[data-theme='dark'] {\n  --color-accent: 200 210 220;\n}");
    // No light override, so nothing may be emitted for the light attribute rule.
    expect(css).not.toContain("html[data-theme='light']");
  });

  test('radius and font ride in :root only — they are not theme-dependent', () => {
    const css = defineTheme({
      radius: { md: '0.125rem', pill: '999px' },
      font: { sans: 'Inter, system-ui, sans-serif' },
    }).css;
    expect(css).toBe(
      ':root {\n' +
        '  --radius-md: 0.125rem;\n' +
        '  --radius-pill: 999px;\n' +
        '  --font-sans: Inter, system-ui, sans-serif;\n' +
        '}',
    );
  });

  test('output is ordered by the canonical scales, not by the input object', () => {
    const a = defineTheme({ colors: { light: { accent: '1 1 1', bg: '2 2 2' } } }).css;
    const b = defineTheme({ colors: { light: { bg: '2 2 2', accent: '1 1 1' } } }).css;
    expect(a).toBe(b);
    expect(a.indexOf('--color-bg:')).toBeLessThan(a.indexOf('--color-accent:'));
  });

  test('the brand is frozen — a rendered stylesheet cannot be mutated after validation', () => {
    const brand = defineTheme({ colors: { light: { accent: '1 1 1' } } });
    expect(Object.isFrozen(brand)).toBe(true);
  });

  test('an unknown role is X_TOKEN_UNKNOWN with the file to edit', () => {
    expect(codeOf(() => defineTheme({ colors: { light: { 'brand-500': '1 1 1' } } }))).toBe(
      UI_ERROR_CODES.tokenUnknown,
    );
    expect(codeOf(() => defineTheme({ radius: { huge: '4rem' } }))).toBe(
      UI_ERROR_CODES.tokenUnknown,
    );
    expect(codeOf(() => defineTheme({ font: { display: 'Inter' } }))).toBe(
      UI_ERROR_CODES.tokenUnknown,
    );
  });

  test('the unknown-radius fix names _radius.scss, not the pluralised guess', () => {
    try {
      defineTheme({ radius: { huge: '4rem' } });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as { fix?: string }).fix).toContain('_radius.scss');
    }
  });

  test('a value that is not a token value is X_UI_INVALID_VALUE', () => {
    const bad = [
      () => defineTheme({ colors: { light: { accent: '#1e6eb2' } } }),
      () => defineTheme({ colors: { dark: { accent: 'rgb(1,2,3)' } } }),
      () => defineTheme({ radius: { md: 'calc(1rem + 2px)' } }),
      () => defineTheme({ font: { sans: 'Inter; }' } }),
    ];
    for (const run of bad) expect(codeOf(run)).toBe(UI_ERROR_CODES.invalidValue);
  });

  test('CSS injection through any slot is refused, never escaped', () => {
    const attacks = [
      () => defineTheme({ colors: { light: { accent: '1 1 1; } html { display: none }' } } }),
      () => defineTheme({ font: { mono: 'Menlo</style><script>alert(1)</script>' } }),
      () => defineTheme({ radius: { sm: '1rem} :root {--color-bg: 0 0 0' } }),
    ];
    for (const run of attacks) expect(codeOf(run)).toBe(UI_ERROR_CODES.invalidValue);
  });
});

describe('brandStyleTag', () => {
  test('wraps the validated css and nothing else', () => {
    const brand = defineTheme({ radius: { md: '0.125rem' } });
    expect(brandStyleTag(brand)).toBe(`<style>${brand.css}</style>`);
    expect(brandStyleTag(brand)).not.toContain('</style><');
  });
});

describe('brandStyleCspSource', () => {
  test('hashes exactly the body the tag carries, so the policy admits that document', () => {
    const brand = defineTheme({ radius: { md: '0.125rem' } });
    const body = brandStyleTag(brand).replace('<style>', '').replace('</style>', '');
    const digest = new Bun.CryptoHasher('sha256').update(body).digest('base64');
    expect(brandStyleCspSource(brand)).toBe(`'sha256-${digest}'`);
  });

  test('a different brand is a different source — the header cannot be checked in', () => {
    expect(brandStyleCspSource(defineTheme({ radius: { md: '0.125rem' } }))).not.toBe(
      brandStyleCspSource(defineTheme({ radius: { md: '0.25rem' } })),
    );
  });
});
