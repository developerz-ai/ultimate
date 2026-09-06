// The diagnostic that could never be closed, from both ends. `x doctor` probed the literal
// `apps/web/app/offline.tsx` — a filename `registerRoute` REFUSES (`X_ROUTE_FILE_INVALID`: the
// directory is the URL and `<name>.tsx` is not a page) — while `x new` scaffolds
// `apps/web/site/offline/page.tsx` and the finding's own `fix:` writes
// `apps/web/app/offline/page.tsx`. So every app the framework produces reported
// `X_PWA_NO_OFFLINE_FALLBACK` on day one, running the fix changed the answer not at all, and the
// app that HAD the route was told it did not.

import { describe, expect, test } from 'bun:test';
import { APP_CONFIG_FILE } from './app-root';
import type { OfflineFallbackFact } from './doctor-offline';
import { offlineFallbackFinding } from './doctor-offline';

const fact = (over: Partial<OfflineFallbackFact> = {}): OfflineFallbackFact => ({
  fallback: '/offline',
  routes: [{ path: '/offline', surface: 'site' }],
  ...over,
});

describe('unit · the offline fallback is resolved against the route table', () => {
  test('a route serving the configured fallback is no finding', () => {
    expect(offlineFallbackFinding(fact())).toBeUndefined();
  });

  // `app/` answers the same URL and cannot answer it OFFLINE, which is the only question here.
  // `SURFACE_SPECS` allows `app/` exactly `stream | ssr`, only a `static` route is prerendered,
  // and the worker precaches a rendered document — so an `app/` fallback has nothing to precache
  // and the navigation reaches the network it is there to survive without. This accepted it until
  // 2026-09 on the argument that both surfaces answer the same URL, while the fix two tests down
  // already refused `--surface app` for that same reason: a check and its remedy disagreeing over
  // one code.
  test('an app/ route answers the URL and does not serve an offline navigation', () => {
    expect(
      offlineFallbackFinding(fact({ routes: [{ path: '/offline', surface: 'app' }] }))?.code,
    ).toBe('X_PWA_NO_OFFLINE_FALLBACK');
  });

  test('the fallback path is what is matched, not a route that merely exists', () => {
    const finding = offlineFallbackFinding(
      fact({ fallback: '/offline', routes: [{ path: '/', surface: 'site' }] }),
    );
    expect(finding?.code).toBe('X_PWA_NO_OFFLINE_FALLBACK');
    expect(finding?.cause).toContain('/offline');
  });

  // An `api/` route answers JSON and `shared/` is not a URL at all, so neither can be the document
  // a navigation falls back to — the same two exclusions the service worker's own route projection
  // makes (`sw-artifacts.ts`).
  test('an api/ or shared/ route does not serve a navigation', () => {
    for (const surface of ['api', 'shared'] as const) {
      expect(offlineFallbackFinding(fact({ routes: [{ path: '/offline', surface }] }))?.code).toBe(
        'X_PWA_NO_OFFLINE_FALLBACK',
      );
    }
  });

  // The half that made the old check unclosable: its `fix:` has to produce a route this same check
  // then accepts. `x g route offline --surface site` writes `apps/web/site/offline/page.tsx`,
  // which registers as `/offline` on the `site` surface — the case above.
  //
  // `site`, and never `app`: the document that answers a lost network has to render with no
  // network, no session and no database, which `app/` (`ssr | stream`) cannot promise
  // (`wiki/Upgrading.md`). It is the same line `@ultimat3/pwa`'s own
  // `X_PWA_NO_OFFLINE_FALLBACK` hands out, and two fixes for one code are two answers.
  test('the fix names the generator for the configured path, and that path clears the check', () => {
    const finding = offlineFallbackFinding(fact({ routes: [] }));
    expect(finding?.fix).toBe('x g route offline --surface site');
    expect(finding?.fix).not.toContain('--surface app');
    const generated = /^x g route ([a-z0-9-]+) --surface (app|site)$/.exec(finding?.fix ?? '');
    const name = generated?.[1] ?? expect.unreachable('the fix is not an x g route invocation');
    // Read off the fix and never defaulted to `site`: the surface the fix names has to be the one
    // the check then accepts, and a default that happens to be the accepted value asserts nothing.
    const surface = generated?.[2] ?? expect.unreachable('the fix names no surface');
    expect(
      offlineFallbackFinding(fact({ routes: [{ path: `/${name}`, surface }] })),
    ).toBeUndefined();
  });

  test('a nested fallback the generator cannot name is answered with the config edit', () => {
    const finding = offlineFallbackFinding(fact({ fallback: '/support/offline', routes: [] }));
    expect(finding?.fix).toContain(APP_CONFIG_FILE);
    // Never `x g route support-offline`, which slugifies to a DIFFERENT url and leaves the finding
    // exactly where it was.
    expect(finding?.fix).not.toContain('x g route');
  });

  // `generateServiceWorker` refuses without one and `serviceWorkerArtifacts` emits no worker at
  // all, so an app with no declared fallback has no offline story whatever its routes are.
  test('no declared fallback is the config edit, and it names app.config.ts', () => {
    const finding = offlineFallbackFinding(fact({ fallback: null }));
    expect(finding?.code).toBe('X_PWA_NO_OFFLINE_FALLBACK');
    expect(finding?.cause).toContain('pwa.offline.fallback');
    expect(finding?.fix).toContain(APP_CONFIG_FILE);
    expect(finding?.at).toBe(APP_CONFIG_FILE);
  });

  // `appEntities`' rule (`schema-drift.ts`) one registry over: a module that will not import
  // leaves the route registry short, and a short registry reads as "no route serves it" — handing
  // out a generator for a route the app already has, over one file's syntax error.
  test('an app that would not load is not judged at all', () => {
    expect(offlineFallbackFinding(fact({ routes: undefined }))).toBeUndefined();
    expect(offlineFallbackFinding(fact({ fallback: null, routes: undefined }))).toBeUndefined();
  });
});
