// Where a request's zone is read from: the zone script's `x_timezone_detected` guess is a source,
// ranked below every zone a person chose and below the header a client sent on purpose.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { rateLimiter } from './rate-limit';
import { jsonResponse } from './response';
import { httpRouter, type Route } from './router';

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });
const route: Route = {
  method: 'GET',
  path: '/zone',
  meta: { name: 'zone', auth: 'public' },
  handler: (_request, ctx) => jsonResponse({ tz: ctx.tz }),
};

async function zoneOf(headers: Record<string, string>, query = ''): Promise<unknown> {
  const response = await httpPipeline({
    table: httpRouter([route]),
    config,
    limiter: rateLimiter({
      config: {
        enabled: false,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 100, refillPerSecond: 1 } },
      },
    }),
    hooks: { authenticate: () => null },
  }).handle(new Request(`http://localhost/zone${query}`, { headers }), { role: 'web' });
  return ((await response.json()) as { tz: unknown }).tz;
}

describe('the detected zone', () => {
  test("a document navigation with only the script's cookie renders in that zone", async () => {
    expect(await zoneOf({ cookie: 'x_timezone_detected=Asia/Kolkata' })).toBe('Asia/Kolkata');
  });

  test('the chosen cookie beats the detected one', async () => {
    const cookie = 'x_timezone_detected=Asia/Kolkata; x_timezone=Europe/Paris';
    expect(await zoneOf({ cookie })).toBe('Europe/Paris');
  });

  test('the x-timezone header beats the detected cookie', async () => {
    expect(
      await zoneOf({ cookie: 'x_timezone_detected=Asia/Kolkata', 'x-timezone': 'America/Lima' }),
    ).toBe('America/Lima');
  });

  test('a bad detected value is ignored, never a failed request', async () => {
    expect(await zoneOf({ cookie: 'x_timezone_detected=Mars/Olympus' })).toBe('UTC');
  });

  test('`?tz=`, the documented share-link source, is read and beats the guess', async () => {
    expect(await zoneOf({ cookie: 'x_timezone_detected=Asia/Kolkata' }, '?tz=Asia/Tokyo')).toBe(
      'Asia/Tokyo',
    );
  });
});

// The `locale` stage's short-circuit: a route that takes its locale from the path reads no locale
// source — `requestLocale` would discard every one — while the zone's sources are still read.
describe('a route whose locale is its path', () => {
  test('reads only ?tz= off the query, and still answers the default locale', async () => {
    const real = URLSearchParams.prototype.get;
    const asked: string[] = [];
    URLSearchParams.prototype.get = function counted(name: string): string | null {
      asked.push(name);
      return real.call(this, name);
    };
    try {
      const response = await httpPipeline({
        table: httpRouter([
          {
            method: 'GET',
            path: '/page',
            meta: { name: 'page', auth: 'public', localeSource: 'path' },
            handler: (_request, ctx) => jsonResponse({ locale: ctx.locale, tz: ctx.tz }),
          },
        ]),
        config,
      }).handle(
        new Request('http://localhost/page?locale=es&tz=Asia/Tokyo', {
          headers: { 'accept-language': 'es', cookie: 'x_locale=es' },
        }),
        { role: 'web' },
      );
      expect(await response.json()).toEqual({ locale: 'en', tz: 'Asia/Tokyo' });
    } finally {
      URLSearchParams.prototype.get = real;
    }
    expect(asked).toEqual(['tz']);
  });
});
