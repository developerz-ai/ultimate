import { describe, expect, test } from 'bun:test';
import { PwaManifestInvalidError } from './errors';
import type { PwaConfig } from './manifest';
import { generateWebManifest, renderThemeColorMeta } from './manifest';

// Resolved token values, not literals chosen here: colours come from the design tokens.
const tokens = {
  light: { themeColor: 'oklch(98% 0 0)', backgroundColor: 'oklch(100% 0 0)' },
  dark: { themeColor: 'oklch(21% 0.01 260)', backgroundColor: 'oklch(17% 0.01 260)' },
};

const base: PwaConfig = {
  name: 'Ultimate Demo',
  shortName: 'Demo',
  tokens,
  shareTarget: {
    action: '/_x/share-target',
    method: 'POST',
    params: { title: 'title', text: 'text', url: 'url' },
  },
  fileHandlers: [{ action: '/open', accept: { 'text/csv': ['.csv'] } }],
  protocolHandlers: [{ protocol: 'web+demo', url: '/handle?u=%s' }],
};

describe('generateWebManifest', () => {
  test('carries theme colours for both colour schemes', () => {
    const { manifest, themeColorMeta } = generateWebManifest(base);

    expect(manifest.theme_color).toBe(tokens.light.themeColor);
    expect(manifest.background_color).toBe(tokens.light.backgroundColor);
    expect(themeColorMeta).toEqual([
      { content: tokens.light.themeColor, media: '(prefers-color-scheme: light)' },
      { content: tokens.dark.themeColor, media: '(prefers-color-scheme: dark)' },
    ]);
    expect(renderThemeColorMeta(themeColorMeta)).toContain('(prefers-color-scheme: dark)');
  });

  test('a disabled capability emits no manifest member', () => {
    const { manifest } = generateWebManifest(base);
    expect('share_target' in manifest).toBe(false);
    expect('file_handlers' in manifest).toBe(false);
    expect('protocol_handlers' in manifest).toBe(false);
  });

  test('an enabled capability emits exactly its member', () => {
    const { manifest } = generateWebManifest({
      ...base,
      capabilities: { shareTarget: true },
    });
    expect(manifest.share_target?.action).toBe('/_x/share-target');
    expect('file_handlers' in manifest).toBe(false);
  });

  test('rejects a start_url outside the scope', () => {
    expect(() => generateWebManifest({ ...base, scope: '/app/', startUrl: '/' })).toThrow(
      PwaManifestInvalidError,
    );
  });

  test('rejects a scheme with no resolved tokens', () => {
    expect(() =>
      generateWebManifest({
        ...base,
        tokens: { light: tokens.light, dark: { themeColor: '', backgroundColor: '' } },
      }),
    ).toThrow(PwaManifestInvalidError);
  });
});

/**
 * `content` and `media` land inside attributes. They are the app's own design tokens rather than
 * request data, so this is the lower-severity half of the same class as `appleTouchLinks` — and
 * the same one-line repair, through the same escaper. `assertValid` only checks non-empty.
 */
describe('renderThemeColorMeta escapes what it interpolates', () => {
  test('a quote in a token value cannot open a second attribute', () => {
    const html = renderThemeColorMeta([
      { content: '#fff" onx="1', media: '(prefers-color-scheme: light)' },
    ]);
    // A second, LIVE attribute needs an unescaped quote to close `content` first; escaped, the
    // whole payload stays one value.
    expect(html).not.toContain('onx="');
    expect(html).toBe(
      '<meta name="theme-color" content="#fff&quot; onx=&quot;1" media="(prefers-color-scheme: light)">',
    );
  });

  test('a resolved token value is emitted verbatim', () => {
    expect(renderThemeColorMeta([{ content: 'oklch(98% 0 0)', media: 'all' }])).toBe(
      '<meta name="theme-color" content="oklch(98% 0 0)" media="all">',
    );
  });
});
