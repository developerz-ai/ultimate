// An answer's instants are named in `x-ultimate-dates` only while the value fits a response
// header: past the cap there is none, the body is untouched, and one `warn` per operation says so.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ctxOf,
  installLogSink,
  reviveWireDates,
  runWithContext,
  wireDatePaths,
  withChildContext,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';
import { httpPipeline } from './pipeline';
import { jsonResponse } from './response';
import type { Route } from './router';
import { httpRouter } from './router';
import { setCookie } from './set-cookie';
import { cappedWireDates, resetWireDatesCap, WIRE_DATES_MAX_BYTES } from './wire-dates-cap';

const AT = new Date('2026-03-04T05:06:07.089Z');
/** A chart series: the string beside each instant shares its pattern, so no path folds. */
const series = (points: number) => ({
  points: Array.from({ length: points }, (_, index) => [`series-${index % 3}`, AT] as const),
});

const routed = (name: string) => {
  const ctx = requestContext({
    url: new URL('http://app.test/chart'),
    method: 'POST',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  });
  const route: Route = {
    method: 'POST',
    path: '/chart',
    meta: { name, auth: 'public' },
    handler: () => new Response(null),
  };
  ctx.route = route;
  return asCtx(ctx);
};

let lines: { readonly level: string; readonly line: string }[] = [];
let release: () => void = () => undefined;

beforeEach(() => {
  resetWireDatesCap();
  lines = [];
  release = installLogSink((line, level) => void lines.push({ level, line }));
});

afterEach(() => release());

const dropped = () => lines.filter(({ line }) => line.includes('http.wire_dates_dropped'));

describe('cappedWireDates', () => {
  test('a value that fits is the value wireDatePaths wrote, and nothing is logged', () => {
    const rows = Array.from({ length: 20_000 }, () => ({ at: AT, title: 'folds to one path' }));
    expect(cappedWireDates(rows, routed('feed'))).toBe(wireDatePaths(rows));
    expect(cappedWireDates({ n: 1 }, routed('feed'))).toBeUndefined();
    expect(cappedWireDates(series(20), routed('feed'))).toBe(wireDatePaths(series(20)));
    expect(dropped()).toEqual([]);
  });

  test("the cap leaves room in a 4 KB proxy buffer for the framework's own header block", async () => {
    // nginx's default `proxy_buffer_size` on a 4 KB page holds the status line and EVERY header.
    // Measured here: a cross-origin HTTPS answer with the framework's security headers, CSP, CORS,
    // rate-limit, trace ids and one 512-byte sealed cookie — then the dates header at the cap.
    const pipeline = httpPipeline({
      table: httpRouter([
        {
          method: 'POST',
          path: '/chart',
          meta: { name: 'chart', auth: 'public' },
          handler: () => {
            setCookie('session', 'x'.repeat(512), { maxAge: 2_592_000 });
            const response = jsonResponse({ ok: true });
            response.headers.set('x-ultimate-dates', 'd'.repeat(WIRE_DATES_MAX_BYTES));
            return response;
          },
        },
      ]),
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        dev: false,
        cors: { origins: ['https://app.example.com'] },
      }),
    });
    const response = await pipeline.handle(
      new Request('https://app.test/chart', {
        method: 'POST',
        headers: { origin: 'https://app.example.com' },
      }),
      { role: 'web', ip: '203.0.113.9' },
    );
    let bytes = 'HTTP/1.1 200 OK\r\n'.length + '\r\n'.length;
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') bytes += name.length + value.length + 4;
    }
    for (const line of response.headers.getSetCookie())
      bytes += 'set-cookie'.length + line.length + 4;
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ultimate-dates')).toHaveLength(WIRE_DATES_MAX_BYTES);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    // Measured ~2 KB without the dates header (As of 2026-11-19); half a KB stays free for an
    // app's own headers (a longer CSP, a `link`, a second cookie).
    expect(bytes).toBeLessThanOrEqual(4_096 - 512);
  });

  test('an answer whose instants cannot fold stays under the cap: past it, no value at all', () => {
    for (const points of [200, 2_000, 20_000]) {
      expect(wireDatePaths(series(points))?.length).toBeGreaterThan(WIRE_DATES_MAX_BYTES);
      expect(cappedWireDates(series(points), routed('chart'))).toBeUndefined();
    }
  });

  test('the boundary is the encoded length: at the cap it is sent, one byte over it is not', () => {
    // One exact path per element; grow the answer until the encoded value crosses the cap.
    let points = 1;
    while ((wireDatePaths(series(points + 1))?.length ?? 0) <= WIRE_DATES_MAX_BYTES) points += 1;
    const fits = cappedWireDates(series(points), routed('edge'));
    expect(fits?.length).toBeLessThanOrEqual(WIRE_DATES_MAX_BYTES);
    expect(reviveWireDates(JSON.parse(JSON.stringify(series(points))), fits ?? null)).toEqual(
      JSON.parse(JSON.stringify(series(points)), (_key, value) =>
        value === AT.toISOString() ? AT : value,
      ),
    );
    expect(cappedWireDates(series(points + 1), routed('edge'))).toBeUndefined();
  });

  test('one warn per operation, naming it, the path count and the size', () => {
    for (let call = 0; call < 3; call += 1) cappedWireDates(series(2_000), routed('chart'));
    cappedWireDates(series(300), routed('otherChart'));
    const seen = dropped();
    expect(seen.map(({ level }) => level)).toEqual(['warn', 'warn']);
    const first = JSON.parse(seen[0]?.line ?? '{}') as Record<string, unknown>;
    expect(first).toMatchObject({
      operation: 'chart',
      paths: 2_000,
      bytes: wireDatePaths(series(2_000))?.length,
      maxBytes: WIRE_DATES_MAX_BYTES,
    });
    expect(JSON.parse(seen[1]?.line ?? '{}')).toMatchObject({
      operation: 'otherChart',
      paths: 300,
    });
  });

  test('the operation is read from the request a derived context runs inside', () => {
    runWithContext(routed('streamed'), () =>
      withChildContext({ locale: 'en' }, () => {
        expect(cappedWireDates(series(500))).toBeUndefined();
      }),
    );
    expect(JSON.parse(dropped()[0]?.line ?? '{}')).toMatchObject({ operation: 'streamed' });
  });

  test('with no request behind it the answer is the same, logged once under one name', () => {
    expect(cappedWireDates(series(500), ctxOf({}))).toBeUndefined();
    expect(cappedWireDates(series(500), undefined)).toBeUndefined();
    expect(cappedWireDates(series(20), undefined)).toBe(wireDatePaths(series(20)));
    expect(dropped()).toHaveLength(1);
  });
});
