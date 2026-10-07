// Single responsibility: pins that `app.config.ts` is a CLOSED shape — a key the framework does not
// declare, at any depth and in any layer, is refused by path with the nearest real key — and that
// the positions whose keys an app chooses (a locale-keyed text) stay open.

import { describe, expect, test } from 'bun:test';
import { type AppConfigInput, defineConfig } from './config';
import { OPEN_CONFIG_PATHS, SECTION_KEYS, unknownConfigKeys } from './config-keys';
import { isUltimateError, type UltimateError } from './errors';

const refusalOf = (...layers: readonly unknown[]): UltimateError => {
  const [base, ...overlays] = layers;
  try {
    defineConfig(base as AppConfigInput, ...(overlays as never[]));
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
  }
  return expect.unreachable(`defineConfig accepted ${JSON.stringify(layers)}`);
};

const PWA_ON = {
  enabled: true,
  offline: { fallback: '/offline' },
  name: 'My App',
  colors: {
    light: { themeColor: '#111111', backgroundColor: '#ffffff' },
    dark: { themeColor: '#111111', backgroundColor: '#000000' },
  },
};

describe('an unknown key is refused by its full path', () => {
  test.each([
    ['foo', { foo: 1 }],
    ['drian', { drian: { deadlineMs: 1000 } }],
    ['realtime.bogus', { realtime: { bogus: 'x' } }],
    ['ai.mcp.bogus', { ai: { mcp: { bogus: true } } }],
    ['ai.model', { ai: { model: 'claude' } }],
    ['jobs.queue', { jobs: { queue: ['mail'] } }],
    ['pwa.offline.fallbak', { pwa: { offline: { fallbak: '/offline' } } }],
    [
      'pwa.colors.light.theme',
      { pwa: { ...PWA_ON, colors: { ...PWA_ON.colors, light: { theme: '#fff' } } } },
    ],
    [
      'pwa.shortcuts[0].href',
      { pwa: { ...PWA_ON, shortcuts: [{ name: 'Panel', href: '/panel' }] } },
    ],
    ['mail.retainMime.max', { mail: { retainMime: { max: 10 } } }],
    ['navigation.clients', { navigation: { clients: ['app'] } }],
    [
      'navigation.speculation.eagerness',
      { navigation: { speculation: { eagerness: 'moderate' } } },
    ],
    ['seo.sitemap.extras', { seo: { sitemap: { extras: ['/a'] } } }],
  ] as const)('%s', (path, said) => {
    const error = refusalOf({ name: 'myapp', ...said });
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain(`${path} is not an app.config.ts key`);
    expect(error.meta?.['unknown']).toEqual([path]);
    expect(error.fix).toEndWith('x verify');
  });

  // A layer key that names an Object.prototype member is still just an unknown key — never one
  // the reference "declares" through its prototype (an `in` check would let these through).
  test.each(['constructor', 'toString', 'hasOwnProperty'])('%s, a prototype name', (key) => {
    const error = refusalOf({ name: 'myapp', [key]: { x: 1 } } as AppConfigInput);
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.meta?.['unknown']).toEqual([key]);
  });

  test('from an overlay too', () => {
    expect(refusalOf({ name: 'myapp' }, { realtime: { trasnport: 'nats' } }).cause).toContain(
      'realtime.trasnport is not an app.config.ts key',
    );
  });

  test('a typo is answered with the key it meant, as the edit to make', () => {
    const error = refusalOf({ name: 'myapp', drian: { deadlineMs: 1000 } });
    expect(error.cause).toContain('did you mean drain?');
    expect(error.fix).toStartWith('rename drian to drain in app.config.ts');
  });

  test('a key with no near neighbour lists what the section does hold', () => {
    const error = refusalOf({ name: 'myapp', realtime: { zzzzzzzz: 1 } });
    expect(error.fix).toStartWith('delete realtime.zzzzzzzz from app.config.ts');
    expect(error.fix).toContain('enabled, transport, urlEnv');
  });

  test('an object at a key whose default is undefined knows no keys', () => {
    const error = refusalOf({ name: 'myapp', realtime: { urlEnv: { name: 'NATS_URL' } } });
    expect(error.meta?.['unknown']).toEqual(['realtime.urlEnv.name']);
    expect(error.fix).toContain('realtime.urlEnv is a value, not a section');
  });

  test('every unknown key in one config is named in one refusal', () => {
    const error = refusalOf({ name: 'myapp', foo: 1, cache: { ttl: 5 } });
    expect(error.meta?.['unknown']).toEqual(['foo', 'cache.ttl']);
  });

  test('a removed key keeps its own, better refusal', () => {
    expect(refusalOf({ name: 'myapp', realtime: { tier: 'channels' } }).cause).toContain(
      'realtime.tier was removed in 10.0.0',
    );
  });
});

describe('what stays open', () => {
  test('a key declared optional with an undefined default is a key', () => {
    const config = defineConfig({
      name: 'myapp',
      realtime: { transport: 'nats', urlEnv: 'NATS_URL', maxSocketsPerActor: 4 },
      notify: { inboxReadRetentionMs: 1000 },
    });
    expect(config.realtime.urlEnv).toBe('NATS_URL');
  });

  test('every optional pwa member, with locale-keyed text, is accepted', () => {
    const config = defineConfig({
      name: 'myapp',
      pwa: {
        ...PWA_ON,
        id: '/',
        description: { en: 'An app', 'es-co': 'Una app' },
        categories: ['business'],
        shortcuts: [
          {
            name: { en: 'Panel', 'es-co': 'Panel' },
            shortName: 'P',
            description: 'Open the panel',
            url: '/panel',
            icons: [{ src: '/i.png', sizes: '96x96', type: 'image/png', purpose: 'any' }],
          },
        ],
        screenshots: [
          {
            src: { en: '/s-en.png', 'es-co': '/s-es.png' },
            sizes: '1280x720',
            type: 'image/png',
            formFactor: 'wide',
            label: { en: 'Home' },
          },
        ],
      },
      mail: { retainMime: { maxBytes: 1024 } },
      navigation: { client: ['app'], speculation: { prefetch: false, exclude: ['/a/*'] } },
    });
    expect(config.pwa.id).toBe('/');
  });

  test('a key written as undefined is a layer not saying', () => {
    expect(() => defineConfig({ name: 'myapp' }, { foo: undefined } as never)).not.toThrow();
  });

  test('a scalar position holding an object is left to its own rule', () => {
    // `site.origin` is a string or null; its own screen names the wrong value, not a key inside it.
    expect(refusalOf({ name: 'myapp', site: { origin: { host: 'x' } } }).meta?.['unknown']).toBe(
      undefined,
    );
  });

  test('every open position is a declared key of its parent, so the list cannot rot', () => {
    for (const path of OPEN_CONFIG_PATHS) {
      const cut = path.lastIndexOf('.');
      const parent = path.slice(0, cut);
      const key = path.slice(cut + 1);
      expect(SECTION_KEYS[parent] ?? []).toContain(key);
    }
  });
});

describe('unknownConfigKeys', () => {
  test.each([[null], [undefined], [5], ['x'], [[]]])(
    'a layer that is %p finds nothing',
    (layer) => {
      expect(unknownConfigKeys({ jobs: { queues: [] } }, layer)).toEqual([]);
    },
  );

  test('walks list elements only where the element is a declared section', () => {
    expect(unknownConfigKeys({ jobs: { queues: [] } }, { jobs: { queues: [{ a: 1 }] } })).toEqual(
      [],
    );
  });
});
