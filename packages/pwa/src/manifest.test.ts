import { describe, expect, test } from 'bun:test';
import { PwaManifestInvalidError } from './errors';
import type { WebManifestInput } from './manifest';
import { generateWebManifest, renderThemeColorMeta, serializeWebManifest } from './manifest';

// Resolved token values, not literals chosen here: colours come from the design tokens.
const tokens = {
  light: { themeColor: 'oklch(98% 0 0)', backgroundColor: 'oklch(100% 0 0)' },
  dark: { themeColor: 'oklch(21% 0.01 260)', backgroundColor: 'oklch(17% 0.01 260)' },
};

const base: WebManifestInput = {
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

describe('capability-gated manifest members', () => {
  test('file handlers and protocol handlers are gated one by one, not together', () => {
    const { manifest } = generateWebManifest({
      ...base,
      capabilities: { fileHandlers: true },
    });

    expect(manifest.file_handlers).toEqual(base.fileHandlers);
    expect('protocol_handlers' in manifest).toBe(false);
    expect('share_target' in manifest).toBe(false);
  });

  test('protocol handlers land under their own manifest member', () => {
    const { manifest, capabilities } = generateWebManifest({
      ...base,
      capabilities: { protocolHandlers: true },
    });

    expect(manifest.protocol_handlers).toEqual([{ protocol: 'web+demo', url: '/handle?u=%s' }]);
    expect(capabilities.protocolHandlers).toBe(true);
    expect(capabilities.fileHandlers).toBe(false);
  });

  test('an enabled capability with nothing configured emits no empty member', () => {
    const { fileHandlers: _f, protocolHandlers: _p, ...withoutHandlers } = base;
    const { manifest } = generateWebManifest({
      ...withoutHandlers,
      capabilities: { fileHandlers: true, protocolHandlers: true },
    });

    expect('file_handlers' in manifest).toBe(false);
    expect('protocol_handlers' in manifest).toBe(false);
  });
});

describe('assertValid', () => {
  test('a blank name is X_PWA_MANIFEST_INVALID with a fix naming the config key', () => {
    let thrown: unknown;
    try {
      generateWebManifest({ ...base, name: '   ' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PwaManifestInvalidError);
    expect(thrown).toMatchObject({
      code: 'X_PWA_MANIFEST_INVALID',
      fix: 'set pwa.name in app.config.ts',
    });
  });

  test('the start_url check names both paths it compared', () => {
    let thrown: unknown;
    try {
      generateWebManifest({ ...base, scope: '/app/', startUrl: '/other' });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { cause: string }).cause).toContain('"/other"');
    expect((thrown as { cause: string }).cause).toContain('"/app/"');
  });
});

describe('serializeWebManifest', () => {
  const { manifest } = generateWebManifest({ ...base, capabilities: { shareTarget: true } });

  test('emits indented JSON ending in a newline, byte-identical across runs', () => {
    const text = serializeWebManifest(manifest);

    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "name": "Ultimate Demo"');
    expect(text).toBe(serializeWebManifest(manifest));
    expect(JSON.parse(text)).toEqual(manifest);
  });
});
