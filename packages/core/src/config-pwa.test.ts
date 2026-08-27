// The `pwa` block alone: what `enabled: true` makes required, and how a partial `offline` block
// merges. Split out of `config.test.ts` at the 500-line ceiling — `config-pwa.ts` is its own module
// for the same reason, and `enabled` turning four other requirements on is one subject.

import { describe, expect, test } from 'bun:test';
import { type AppConfig, defineConfig } from './config';
import { PWA_COLOR_KEYS, PWA_SCHEMES } from './config-pwa';
import { isUltimateError, type UltimateError } from './errors';

describe('defineConfig · the pwa block an install can be built from', () => {
  const COLORS = {
    light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
    dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
  } as const;

  const causeOf = (build: () => AppConfig): string => {
    try {
      build();
    } catch (error) {
      if (isUltimateError(error)) return (error as UltimateError).cause;
      throw error;
    }
    return expect.unreachable('the config was accepted');
  };

  test('a disabled block needs neither, and resolves to no colours at all', () => {
    const config = defineConfig({ name: 'myapp' });
    expect(config.pwa.enabled).toBe(false);
    expect(config.pwa.name).toBe('');
    // Never a colour the framework picked: an install splash in an unchosen colour is a wrong
    // -looking app that boots, which is worse than a boot naming the four values it needs.
    expect(config.pwa.colors).toBeUndefined();
  });

  test('enabled with no name is refused, and the fix carries the whole block', () => {
    let fix = '';
    try {
      defineConfig({ name: 'myapp', pwa: { enabled: true, colors: COLORS } });
      expect.unreachable('an installable app with no title was accepted');
    } catch (error) {
      if (!isUltimateError(error)) throw error;
      expect(error.cause).toContain('pwa.name is required');
      fix = (error as UltimateError).fix;
    }
    // Axiom 4: the remedy is the complete block plus the opt-out, because `enabled` is the one key
    // that turns four other requirements on.
    expect(fix).toContain("name: 'My App'");
    expect(fix).toContain('themeColor');
    expect(fix).toContain('pwa.enabled: false');
  });

  // An untyped `app.config.ts` is what this validator is FOR, so `null` has to reach the refusal
  // rather than `null[scheme]`: a native TypeError out of the function whose job is producing an
  // instruction is the one failure it must not have. `false`/a string take the same branch.
  test.each([null, false, 'themeColor: #fff', 7])(
    'pwa.colors set to %p is refused with an instruction, never a TypeError',
    (colors) => {
      const cause = causeOf(() =>
        defineConfig({
          name: 'myapp',
          // The cast IS the case: this validator's inputs come from a JS file nothing typechecked.
          pwa: { enabled: true, name: 'My App', colors: colors as never },
        }),
      );
      expect(cause).toContain('pwa.colors is required');
    },
  );

  test('enabled with no colours is refused', () => {
    expect(
      causeOf(() => defineConfig({ name: 'myapp', pwa: { enabled: true, name: 'My App' } })),
    ).toContain('pwa.colors is required');
  });

  // Per scheme and per key, because a manifest with a blank `theme_color` is a manifest a browser
  // accepts and paints wrong — there is no downstream check that can fail on it.
  test.each([
    ['light', 'themeColor'],
    ['light', 'backgroundColor'],
    ['dark', 'themeColor'],
    ['dark', 'backgroundColor'],
  ] as const)('a blank %s.%s is refused', (scheme, key) => {
    const colors = { ...COLORS, [scheme]: { ...COLORS[scheme], [key]: '   ' } };
    const cause = causeOf(() =>
      defineConfig({ name: 'myapp', pwa: { enabled: true, name: 'My App', colors } }),
    );
    expect(cause).toContain(`pwa.colors.${scheme}.${key} must be a CSS colour`);
  });

  // The pwa remedy must not ride on somebody else's finding: an app with a bad locale and a
  // perfectly good pwa block would otherwise be told to rewrite its install colours.
  test('an unrelated finding does not attract the install fix', () => {
    try {
      defineConfig({ name: 'myapp', locales: ['not a tag'], defaultLocale: 'not a tag' });
      expect.unreachable('a bad locale was accepted');
    } catch (error) {
      if (!isUltimateError(error)) throw error;
      expect((error as UltimateError).fix).not.toContain('themeColor');
    }
  });

  test('a complete block is accepted and kept verbatim', () => {
    const config = defineConfig({
      name: 'myapp',
      pwa: { enabled: true, offline: { fallback: '/offline' }, name: 'My App', colors: COLORS },
    });
    expect(config.pwa.name).toBe('My App');
    expect(config.pwa.colors).toEqual(COLORS);
    expect(config.pwa.offline.fallback).toBe('/offline');
  });

  test('a partial offline block keeps the defaults beside it, one level down', () => {
    // `section` applies a patch ONE level deep, so a flat `Input<PwaConfig>` would have replaced
    // the whole block — leaving `image`, `font` and `neverCache` absent at run time while the type
    // said they were there. `PwaConfigInput` nests `offline` for exactly this.
    const config = defineConfig({
      name: 'myapp',
      pwa: { enabled: true, offline: { fallback: '/offline' }, name: 'My App', colors: COLORS },
    });
    expect(config.pwa.offline).toEqual({
      fallback: '/offline',
      image: null,
      font: null,
      neverCache: [],
    });
  });

  test.each([undefined, null, '', 'offline', 7])(
    'pwa.offline.fallback set to %p is refused: an installable app owes an offline document',
    (fallback) => {
      const cause = causeOf(() =>
        defineConfig({
          name: 'myapp',
          // The cast IS the case: a hand-written `app.config.ts` is what this validator is for,
          // and a RELATIVE path is the one that reads as fine and resolves against whatever
          // document registered the worker — `/posts/1` + `offline` is `/posts/offline`.
          pwa: {
            enabled: true,
            name: 'My App',
            colors: COLORS,
            offline: { fallback: fallback as never },
          },
        }),
      );
      expect(cause).toContain('pwa.offline.fallback is required');
    },
  );

  // `INBOX_RETENTION_KEYS`' rule, one section over: a third scheme or a third colour added to the
  // types with no row in the screened list is a value an app can leave blank.
  test('every scheme and colour the types declare is one validate screens', () => {
    const config = defineConfig({
      name: 'myapp',
      pwa: { enabled: true, name: 'My App', colors: COLORS, offline: { fallback: '/offline' } },
    });
    const colors = config.pwa.colors ?? expect.unreachable('the colours were dropped');
    // Widened, exactly as the retention test widens `INBOX_RETENTION_KEYS`: the constants are
    // `readonly ['light', 'dark']` and `Object.keys` answers `string[]`.
    const schemes: string[] = [...PWA_SCHEMES];
    const keys: string[] = [...PWA_COLOR_KEYS];
    expect(schemes.sort()).toEqual(Object.keys(colors).sort());
    expect(keys.sort()).toEqual(Object.keys(colors.light).sort());
    expect(keys.sort()).toEqual(Object.keys(colors.dark).sort());
  });
});
