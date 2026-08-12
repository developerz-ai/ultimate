import { describe, expect, test } from 'bun:test';
import { checkDocumentStyles, definesRootCustomProperties } from './document-styles';

// Verbatim shapes: the left one is what the deployed demo actually served, the right one is what
// `@ultimat3/ui`'s token layer compiles to.
const USES_ONLY = '.hero_1f2e{background:rgb(var(--color-bg)/1);padding:var(--space-8)}';
const DEFINES = ':root{color-scheme:light;--color-bg: 253 246 240}';

describe('definesRootCustomProperties', () => {
  test('a document full of var() uses and no definitions does not pass', () => {
    expect(definesRootCustomProperties(USES_ONLY)).toBe(false);
  });

  test('a :root block that defines one is what passing means', () => {
    expect(definesRootCustomProperties(DEFINES + USES_ONLY)).toBe(true);
  });

  test('no CSS at all is no tokens either — an empty document fails the same way', () => {
    expect(definesRootCustomProperties('')).toBe(false);
  });

  test('a custom property scoped to a class is not the global layer', () => {
    expect(definesRootCustomProperties('.tone-danger{--color-accent: 190 42 42}')).toBe(false);
  });

  test('a :root inside a media query counts — dark theme is a token flip, not a second layer', () => {
    expect(
      definesRootCustomProperties(
        '@media(prefers-color-scheme: dark){:root{--color-bg: 18 18 20}}',
      ),
    ).toBe(true);
  });
});

describe('checkDocumentStyles', () => {
  test('the bug this exists for: component rules, zero definitions, one finding per surface', () => {
    const findings = checkDocumentStyles([
      { surface: 'site', css: USES_ONLY },
      { surface: 'app', css: USES_ONLY },
    ]);
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_STYLES_GLOBAL_MISSING',
      'X_STYLES_GLOBAL_MISSING',
    ]);
    expect(findings[0]?.cause).toContain('site/');
    expect(findings[0]?.fix).toContain('global.scss');
  });

  test('a document carrying the global layer is not a finding', () => {
    expect(checkDocumentStyles([{ surface: 'site', css: DEFINES + USES_ONLY }])).toEqual([]);
  });

  test('a surface that renders no document is never asked', () => {
    expect(checkDocumentStyles([])).toEqual([]);
  });
});
