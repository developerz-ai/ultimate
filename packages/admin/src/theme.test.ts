// Branding is token→token aliasing and nothing else. The typed side (`accent: '#7c3aed'` is a
// compile error) is the compiler's job; what is testable here is that every alias comes out as a
// `var()` reference, and that `system` deliberately emits NO `data-theme` so the media query wins.

import { describe, expect, test } from 'bun:test';
import { adminBranding, defaultBranding, type ThemeTokenRef, themeAttributes } from './theme';

describe('adminBranding', () => {
  test('an empty input is the default branding, not an empty object', () => {
    expect(adminBranding()).toEqual(defaultBranding);
    expect(defaultBranding.mode).toBe('system');
    expect(defaultBranding.density).toBe('comfortable');
  });

  test('a declared field wins and the rest of the default survives', () => {
    const branding = adminBranding({ nameKey: 'acme.brand', density: 'compact' });
    expect(branding.nameKey).toBe('acme.brand');
    expect(branding.density).toBe('compact');
    // Not restated by the caller, so the default has to still be there.
    expect(branding.mode).toBe('system');
  });
});

describe('themeAttributes', () => {
  test('system emits no data-theme, so prefers-color-scheme decides', () => {
    const attributes = themeAttributes(adminBranding());
    expect('data-theme' in attributes).toBe(false);
    expect(attributes['data-density']).toBe('comfortable');
    expect(attributes.style).toBe('');
  });

  test('a pinned mode emits data-theme and wins over the media query', () => {
    expect(themeAttributes(adminBranding({ mode: 'dark' }))['data-theme']).toBe('dark');
    expect(themeAttributes(adminBranding({ mode: 'light' }))['data-theme']).toBe('light');
  });

  test('an accent becomes a var() alias of --x-color-accent, never a literal', () => {
    const attributes = themeAttributes(
      adminBranding({ accent: '--x-color-brand' as ThemeTokenRef }),
    );
    expect(attributes.style).toBe('--x-color-accent: var(--x-color-brand);');
  });

  test('extra token aliases follow the accent, each one a var() of the source token', () => {
    const attributes = themeAttributes(
      adminBranding({
        accent: '--x-color-brand' as ThemeTokenRef,
        tokens: {
          '--x-color-surface': '--x-color-brand-surface',
          '--x-color-border': '--x-color-brand-border',
        } as Readonly<Partial<Record<ThemeTokenRef, ThemeTokenRef>>>,
      }),
    );
    expect(attributes.style).toBe(
      '--x-color-accent: var(--x-color-brand); ' +
        '--x-color-surface: var(--x-color-brand-surface); ' +
        '--x-color-border: var(--x-color-brand-border);',
    );
  });

  test('a token whose source is undefined is skipped rather than emitting var(undefined)', () => {
    const attributes = themeAttributes(
      adminBranding({
        tokens: { '--x-color-surface': undefined } as Readonly<
          Partial<Record<ThemeTokenRef, ThemeTokenRef>>
        >,
      }),
    );
    expect(attributes.style).toBe('');
  });

  test('a branding with neither mode nor density still answers the density attribute', () => {
    // `adminBranding` is bypassed on purpose: `themeAttributes` is exported and a host can
    // hand it a hand-built object, so its own fallbacks have to hold.
    const attributes = themeAttributes({ nameKey: 'acme.brand' });
    expect('data-theme' in attributes).toBe(false);
    expect(attributes['data-density']).toBe('comfortable');
  });
});
