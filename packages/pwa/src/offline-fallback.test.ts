import { describe, expect, test } from 'bun:test';
import { CLIENT_NAVIGATION_HEADER } from '@ultimat3/core';
import { PwaNoOfflineFallbackError } from './errors';
import { offlineFallbackSource, requireOfflineFallback } from './offline-fallback';

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

describe('requireOfflineFallback', () => {
  test('you cannot ship without one, and the fix is the exact edit', () => {
    let fix = '';
    try {
      requireOfflineFallback(undefined);
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toBe(
      "set pwa: { offline: { fallback: '/offline' } } in app.config.ts, then create the route it names: x g route offline --surface site",
    );
    // The half a string comparison alone would not explain: `<name>.tsx` is not a route file.
    // `registerRoute` refuses it with `X_ROUTE_FILE_INVALID` — the directory is the URL — so the
    // fix this line USED to hand out (`app/offline.tsx`) was an instruction that fails at the
    // first `x verify` after it is followed, and `wiki/Upgrading.md` already records that path as
    // the wrong one. `site/`, not `app/`: the document answering a lost network has to render with
    // no network, no session and no database, which `app/` (`ssr | stream`) cannot promise.
    expect(fix).not.toMatch(/\boffline\.tsx\b/);
    expect(fix).toContain('--surface site');
    // No `#`: a shell comment is what made the previous line half-run. Pasted whole it created the
    // route and left `pwa.offline.fallback` unset, so the next build raised this same error — and
    // the reader had no signal that anything was left to do. Both actions, or neither.
    expect(fix).not.toContain('#');
    // The nested literal and not the dotted key, because there is no `pwa` block to set a key in:
    // this branch fires when the config has none. It is the same line `x doctor`'s own
    // `offlineFallbackFinding` hands out for the same code — two spellings of one instruction is
    // how one of them rots.
    expect(fix).toContain("pwa: { offline: { fallback: '/offline' } }");
    expect(fix).toContain('app.config.ts');

    expect(() => requireOfflineFallback({})).toThrow(PwaNoOfflineFallbackError);
    expect(() => requireOfflineFallback({ fallback: '  ' })).toThrow(PwaNoOfflineFallbackError);
  });

  test('the block-missing and fallback-missing refusals hand out the SAME edit', () => {
    // Two causes, one remedy: "no `offline` block" and "an `offline` block with no `fallback`" are
    // repaired by the same two steps, and two spellings of one instruction is how one of them
    // rots. A caller sees whichever cause applies and the same runnable line either way.
    let blockMissing = '';
    let fallbackMissing = '';
    try {
      requireOfflineFallback(null);
    } catch (error) {
      blockMissing = fixOf(error);
    }
    try {
      requireOfflineFallback({});
    } catch (error) {
      fallbackMissing = fixOf(error);
    }
    expect(blockMissing).toBe(fallbackMissing);
    expect(blockMissing).not.toBe('');
  });

  test('rejects a relative fallback path and suggests the absolute one', () => {
    let fix = '';
    try {
      requireOfflineFallback({ fallback: 'offline' });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain("'/offline'");
    // The key's full path, because that is what an author edits: `offline.fallback` names no key
    // `app.config.ts` has, and `pwa.offline.fallback` does.
    expect(fix).toContain('pwa.offline.fallback');
  });

  /**
   * The placeholders are precached and served as the answer to a failed request, so a URL off this
   * origin is a cross-origin fetch at install and a third party's bytes in the app's cache. Same
   * rule as `fallback`: a path on this origin — `/…`, never `//host` or `/\\host`, which a
   * browser resolves to another host.
   */
  test.each([
    ['image', 'https://cdn.example/offline.png'],
    ['font', '//cdn.example/fallback.woff2'],
    ['font', '/\\cdn.example/fallback.woff2'],
    ['image', 'offline.png'],
    ['fallback', '//evil.example/offline'],
    // The URL parser strips the tab: this IS `//evil.example/x` once a browser reads it.
    ['fallback', '/\t/evil.example/x'],
    ['image', '/\n/cdn.example/offline.png'],
    ['font', '/.//cdn.example/fallback.woff2'],
  ] as const)('refuses an off-origin %s: %s', (key, url) => {
    let caught: unknown;
    try {
      requireOfflineFallback({ fallback: '/offline', [key]: url });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PwaNoOfflineFallbackError);
    expect(fixOf(caught)).toContain(`pwa.offline.${key}`);
  });

  test('a same-origin image and font pass', () => {
    const fallback = requireOfflineFallback({
      fallback: '/offline',
      image: '/icons/offline.png',
      font: '/assets/fonts/fallback.0a1b2c3d.woff2',
    });
    expect(fallback.image).toBe('/icons/offline.png');
    expect(fallback.font).toBe('/assets/fonts/fallback.0a1b2c3d.woff2');
  });

  test('emits a fallback handler covering navigations and images', () => {
    const fallback = requireOfflineFallback({ fallback: '/offline', image: '/offline.svg' });
    expect(fallback.document).toBe('/offline');

    const source = offlineFallbackSource(fallback);
    expect(source).toContain('"/offline"');
    expect(source).toContain("req.mode==='navigate'");
    expect(source).toContain("req.destination==='image'");
  });

  /**
   * `pwa.offline.font` was accepted, typed and documented as read — and never reached `sw.js`, so a
   * font request offline got the bare 503 whatever the app configured. The emitted handler is RUN
   * here over a fake precache, never grepped: a name in the source proves nothing about the branch.
   */
  describe('the emitted handler, run', () => {
    interface FakeRequest {
      readonly mode: string;
      readonly destination: string;
      readonly url: string;
      readonly headers?: Headers;
    }
    type Handler = (req: FakeRequest) => Promise<Response>;

    function handler(source: string, precached: Readonly<Record<string, string>>): Handler {
      const caches = {
        open: async () => ({
          match: async (url: string) => {
            const body = precached[url];
            return body === undefined ? undefined : new Response(body);
          },
        }),
      };
      const run = new Function('caches', 'PRECACHE', `${source}\nreturn offlineFallback;`)(
        caches,
        'x-precache-test',
      ) as Handler;
      // A worker's request always carries headers; a case that names none sends none.
      return (req) => run({ headers: new Headers(), ...req });
    }

    const precached = {
      '/offline': 'offline page',
      '/offline.svg': 'placeholder image',
      '/offline.woff2': 'fallback font',
    };

    test('a configured font fallback reaches the emitted worker', async () => {
      const fallback = requireOfflineFallback({ fallback: '/offline', font: '/offline.woff2' });
      const run = handler(offlineFallbackSource(fallback), precached);
      const font = await run({
        mode: 'no-cors',
        destination: 'font',
        url: 'https://x.test/a.woff2',
      });
      expect(font.status).toBe(200);
      expect(await font.text()).toBe('fallback font');
      // The font placeholder answers fonts only: an image with no image fallback is still the 503.
      const image = await run({
        mode: 'no-cors',
        destination: 'image',
        url: 'https://x.test/a.png',
      });
      expect(image.status).toBe(503);
    });

    test('with no font configured a font request is the 503, not some other placeholder', async () => {
      const fallback = requireOfflineFallback({ fallback: '/offline', image: '/offline.svg' });
      const run = handler(offlineFallbackSource(fallback), precached);
      const font = await run({
        mode: 'no-cors',
        destination: 'font',
        url: 'https://x.test/a.woff2',
      });
      expect(font.status).toBe(503);
      const image = await run({
        mode: 'no-cors',
        destination: 'image',
        url: 'https://x.test/a.png',
      });
      expect(await image.text()).toBe('placeholder image');
    });

    test('a font fallback that was never precached falls through to the 503', async () => {
      const fallback = requireOfflineFallback({ fallback: '/offline', font: '/missing.woff2' });
      const run = handler(offlineFallbackSource(fallback), precached);
      const font = await run({
        mode: 'no-cors',
        destination: 'font',
        url: 'https://x.test/a.woff2',
      });
      expect(font.status).toBe(503);
    });

    // #627: the client router's soft navigation is a `fetch` (mode `cors`), not a browser
    // navigation — offline it got the bare 503, which the tab then showed as a `blob:` URL. The
    // router's own header marks it a navigation; a prefetch (a guess) is not one, or the offline
    // page would be cached as the answer to a later click.
    test('a soft navigation from the client router is answered with the offline document', async () => {
      const fallback = requireOfflineFallback({ fallback: '/offline' });
      const run = handler(offlineFallbackSource(fallback, ['en']), precached);
      const visit = (url: string, purpose: string) =>
        run({
          mode: 'cors',
          destination: '',
          url,
          headers: new Headers({ [CLIENT_NAVIGATION_HEADER]: purpose }),
        });
      const soft = await visit('https://x.test/casos', 'soft');
      expect([soft.status, await soft.text()]).toEqual([200, 'offline page']);
      expect((await visit('https://x.test/casos', 'prefetch')).status).toBe(503);
      const bare = await run({ mode: 'cors', destination: '', url: 'https://x.test/casos' });
      expect(bare.status).toBe(503);
    });
  });
});
