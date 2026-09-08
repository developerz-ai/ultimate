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

function fixOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { fix?: string }).fix;
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
    // A READABLE pair: `defineTheme` measures every pairing this brand can have changed against
    // WCAG 2.2 AA, so a fixture of two arbitrary near-black channels is now a refusal rather than
    // an ordering fixture. `bg` is one channel off the shipped value, which keeps every ratio.
    const a = defineTheme({ colors: { light: { accent: '1 1 1', bg: '253 246 241' } } }).css;
    const b = defineTheme({ colors: { light: { bg: '253 246 241', accent: '1 1 1' } } }).css;
    expect(a).toBe(b);
    // The two declarations adjacent and in `COLOR_ROLES` order, not a pairwise `indexOf`: a role
    // that stopped being emitted answers -1, which is less than every real index, so the pairwise
    // form read as ordered for a stylesheet that had dropped `--color-bg` altogether.
    expect(a).toContain('--color-bg: 253 246 241;\n  --color-accent: 1 1 1;');
  });

  describe('a palette that fails WCAG 2.2 AA is refused, not warned about', () => {
    test('body text the new background swallows', () => {
      // Mid grey under the shipped `fg`: the commonest way a brand goes unreadable is changing one
      // side of a pairing and never measuring the other.
      expect(() => defineTheme({ colors: { light: { bg: '110 110 110' } } })).toThrow(
        expect.objectContaining({ code: UI_ERROR_CODES.contrastInsufficient }),
      );
    });

    test('an accent so pale that both the link text and the white label on it vanish', () => {
      // Half a pairing changed: `accent-fg` is white and untouched, and the surfaces are too.
      expect(() => defineTheme({ colors: { light: { accent: '235 235 235' } } })).toThrow(
        expect.objectContaining({ code: UI_ERROR_CODES.contrastInsufficient }),
      );
    });

    test('the refusal names the measured ratio, the required one, and the role to move', () => {
      try {
        defineTheme({ colors: { light: { bg: '110 110 110' } } });
        expect.unreachable('an unreadable palette rendered a stylesheet');
      } catch (error) {
        const failure = error as { cause?: string; fix?: string };
        expect(failure.cause).toContain('WCAG 2.2 AA requires 4.5:1');
        expect(failure.cause).toContain('light palette');
        // Arithmetic, not guesswork: the author needs the number they are short by.
        expect(failure.cause).toMatch(/measures \d+\.\d\d:1/);
        expect(failure.fix).toContain('defineTheme');
      }
    });

    test('a readable override still renders', () => {
      // The check is a real bar in both directions, or it is a rule that only ever says no.
      const css = defineTheme({ colors: { light: { accent: '21 92 152' } } }).css;
      expect(css).toContain('--color-accent: 21 92 152;');
    });

    test('a brand that changes no colour is measured for nothing it did not touch', () => {
      // Blaming an app for the framework's own palette is how a rule gets switched off.
      expect(() => defineTheme({ radius: { md: '0.125rem' } })).not.toThrow();
    });
  });

  test('the brand is frozen — a rendered stylesheet cannot be mutated after validation', () => {
    const brand = defineTheme({ colors: { light: { accent: '1 1 1' } } });
    expect(Object.isFrozen(brand)).toBe(true);
  });

  // Two halves of one proof, and neither replaces the other. Each `@ts-expect-error` asserts the
  // COMPILE-time refusal: an unknown role is not spellable in `BrandInput`, and deleting a role
  // from `COLOR_ROLES`/`radiusTokens`/`FONT_SLOTS` would make the directive itself unused and red.
  // The `codeOf` assertions below it assert the RUNTIME refusal, which is not redundant — a brand
  // read from a JSON config file reaches `defineTheme` with no type having seen it.
  test('an unknown role is X_TOKEN_UNKNOWN with the file to edit', () => {
    // @ts-expect-error 'brand-500' is not a ColorRole
    const badColor = () => defineTheme({ colors: { light: { 'brand-500': '1 1 1' } } });
    // @ts-expect-error 'huge' is not a RadiusName
    const badRadius = () => defineTheme({ radius: { huge: '4rem' } });
    // @ts-expect-error 'display' is not a FontSlot
    const badFont = () => defineTheme({ font: { display: 'Inter' } });

    expect(codeOf(badColor)).toBe(UI_ERROR_CODES.tokenUnknown);
    expect(codeOf(badRadius)).toBe(UI_ERROR_CODES.tokenUnknown);
    expect(codeOf(badFont)).toBe(UI_ERROR_CODES.tokenUnknown);
  });

  test('the unknown-radius fix names _radius.scss, not the pluralised guess', () => {
    // @ts-expect-error 'huge' is not a RadiusName — see the note above
    const badRadius = () => defineTheme({ radius: { huge: '4rem' } });
    expect(fixOf(badRadius)).toContain('_radius.scss');
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
