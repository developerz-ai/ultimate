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
