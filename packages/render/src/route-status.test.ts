// The one way a loader answers a response STATUS while still rendering the route's own page.
// Measured in ai-maxxing on 2026-09-07: `/fleet/nope` rendered the app's own "Not found" page,
// inside its shell, and answered 200 — because the only route to a 404 was throwing, which renders
// the framework's error page OUTSIDE the shell. These pin the seam that closes that.
import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { defineRoute } from './route';
import { metaContextFor, routeDataFor } from './route-data';
import { DEFAULT_ROUTE_STATUS, routeStatusOf, withStatus } from './route-status';

const CTX = { params: { host: 'nope' }, url: 'http://localhost/fleet/nope' } as const;

const base = {
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'never',
} as const;

const codeOf = (thrown: unknown): string =>
  thrown instanceof UltimateError ? thrown.code : `not an UltimateError: ${String(thrown)}`;

describe('withStatus', () => {
  test('hands the SAME object back, so the page and meta read what the loader built', () => {
    const data = { kind: 'missing', hostId: 'nope' } as const;
    expect(withStatus(404, data)).toBe(data);
    expect(routeStatusOf(data)).toBe(404);
  });

  test('a frozen object can carry a status — the mark never mutates the data', () => {
    const data = Object.freeze({ kind: 'gone' });
    expect(withStatus(410, data)).toBe(data);
    expect(routeStatusOf(data)).toBe(410);
  });

  test('unmarked data is 200, and so is anything that is not an object', () => {
    expect(routeStatusOf({ id: '7' })).toBe(DEFAULT_ROUTE_STATUS);
    expect(routeStatusOf(undefined)).toBe(DEFAULT_ROUTE_STATUS);
    expect(routeStatusOf('a string')).toBe(DEFAULT_ROUTE_STATUS);
    expect(DEFAULT_ROUTE_STATUS).toBe(200);
  });

  test('the last mark wins — a loader that re-decides answers its final word', () => {
    const data = { kind: 'page' };
    withStatus(404, data);
    withStatus(200, data);
    expect(routeStatusOf(data)).toBe(200);
  });

  test('a 3xx is refused by name: a redirect needs a Location, not a page', () => {
    let code = '';
    let fix = '';
    try {
      withStatus(302, { kind: 'moved' });
    } catch (thrown) {
      code = codeOf(thrown);
      fix = thrown instanceof UltimateError ? thrown.fix : '';
    }
    expect(code).toBe('X_ROUTE_STATUS_INVALID');
    expect(fix).toContain('redirect');
  });

  test('a status new Response() would refuse is screened here, with a fix, not two frames up', () => {
    // `??` guards nullish and `NaN` is not nullish: a status read off a config or a JSON body walks
    // to `new Response` intact and dies there as a bare `RangeError`. `finiteStatus` is the screen.
    expect(() => withStatus(Number.NaN, { kind: 'x' })).toThrow(UltimateError);
    expect(() => withStatus(199, { kind: 'x' })).toThrow(UltimateError);
    expect(() => withStatus(600, { kind: 'x' })).toThrow(UltimateError);
    expect(() => withStatus(404.5, { kind: 'x' })).toThrow(UltimateError);
  });
});

describe('a loader answering a status', () => {
  test('routeDataFor hands the marked object through, status intact', async () => {
    const config = defineRoute({
      ...base,
      load: ({ params }) =>
        params['host'] === 'nope'
          ? withStatus(404, { kind: 'missing' as const, hostId: params['host'] })
          : { kind: 'page' as const, hostId: params['host'] ?? '' },
      meta: ({ data }) => ({ title: data.kind }),
    });
    const data = await routeDataFor(config, CTX);
    expect(data).toEqual({ kind: 'missing', hostId: 'nope' });
    expect(routeStatusOf(data)).toBe(404);
  });

  test('a route with no load — the context as its data — is 200, exactly as before', async () => {
    const config = defineRoute({ ...base, meta: () => ({ title: 't' }) });
    expect(routeStatusOf(await routeDataFor(config, CTX))).toBe(200);
  });

  test('a 404 is noindex BY CONSTRUCTION, whatever meta declared', async () => {
    const config = defineRoute({
      ...base,
      load: () => withStatus(404, { kind: 'missing' }),
      // An author who forgot, or one who said the wrong thing: a page that does not exist must
      // not be indexed, and that is the framework's decision, not the route's.
      meta: () => ({ title: 'Not found', robots: { index: true, follow: true } }),
    });
    const data = await routeDataFor(config, CTX);
    const meta = await config.meta(metaContextFor(CTX, data));
    expect(meta.robots?.index).toBe(false);
    // Only `index` is decided here; the rest of the author's directives ride through.
    expect(meta.robots?.follow).toBe(true);
    expect(meta.title).toBe('Not found');
  });

  test('a 410 is noindex too — every 4xx and 5xx is a page a crawler must forget', async () => {
    const config = defineRoute({
      ...base,
      load: () => withStatus(410, { kind: 'gone' }),
      meta: () => ({ title: 'Gone' }),
    });
    const meta = await config.meta(metaContextFor(CTX, await routeDataFor(config, CTX)));
    expect(meta.robots).toEqual({ index: false });
  });

  test('a 200 leaves meta exactly as the author wrote it — an untouched app is byte-identical', async () => {
    const declared = { title: 'Host', robots: { index: true } };
    const config = defineRoute({
      ...base,
      load: () => ({ kind: 'page' }),
      meta: () => declared,
    });
    const meta = await config.meta(metaContextFor(CTX, await routeDataFor(config, CTX)));
    expect(meta).toBe(declared);
  });

  test("the build's measurer — params: {} — renders a 404-answering loader without failing", async () => {
    // `x build --target static` weighs an `app/` route by rendering it with no params. A loader
    // that answers 404 for an id it cannot find must still hand back data the page can render:
    // the status is a fact ABOUT the data, never a throw.
    const config = defineRoute({
      ...base,
      load: ({ params }) =>
        withStatus(404, { kind: 'missing' as const, hostId: params['host'] ?? '' }),
      meta: ({ data }) => ({ title: data.hostId === '' ? 'no host' : data.hostId }),
    });
    const ctx = { params: {}, url: 'http://localhost/fleet/:host' };
    const data = await routeDataFor(config, ctx);
    expect(data).toEqual({ kind: 'missing', hostId: '' });
    expect(routeStatusOf(data)).toBe(404);
    expect((await config.meta(metaContextFor(ctx, data))).title).toBe('no host');
  });
});
