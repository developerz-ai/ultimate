// A signed-in member's saved locale and zone are the `user` rung of the owners' precedence
// (`resolveLocale`, `resolveTimeZone`). The `locale` stage runs BEFORE `auth`, so it cannot know
// them; these tests prove the pipeline re-resolves once the actor is known — and that a choice the
// reader made with the cookie still beats the saved locale, exactly where i18n's order says so.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { createRateLimiter } from './rate-limit';
import { json } from './response';
import { createRouter, type Route } from './router';

beforeEach(() => {
  configureLocales({ supported: ['en', 'es', 'de'], fallback: 'en' });
});
afterEach(() => {
  resetLocaleConfig();
});

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });
const route: Route = {
  method: 'GET',
  path: '/me',
  meta: { name: 'me', auth: 'public' },
  handler: (_request, ctx) => json({ locale: ctx.locale, tz: ctx.tz }),
};

function serve(actor: Actor | null, headers: Record<string, string>): Promise<Response> {
  return createPipeline({
    table: createRouter([route]),
    config,
    limiter: createRateLimiter({
      config: {
        enabled: false,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 100, refillPerSecond: 1 } },
      },
    }),
    hooks: { authenticate: () => actor },
  }).handle(new Request('http://localhost/me', { headers }), { role: 'web' });
}

const bruno = userActor({ id: 'bruno', locale: 'es', tz: 'Europe/Madrid' });
const english = { 'accept-language': 'en-US,en;q=0.9' };

describe("a member's saved preferences", () => {
  test("apply over the browser's header once the actor is known", async () => {
    const response = await serve(bruno, english);
    expect(await response.json()).toEqual({ locale: 'es', tz: 'Europe/Madrid' });
    expect(response.headers.get('content-language')).toBe('es');
  });

  test('the locale cookie the reader chose still beats the saved locale; the saved zone comes first', async () => {
    const response = await serve(bruno, {
      ...english,
      cookie: 'x_locale=de; x_timezone=America/New_York',
    });
    expect(await response.json()).toEqual({ locale: 'de', tz: 'Europe/Madrid' });
  });

  test('an anonymous visitor, and a member with nothing saved, keep what the stage resolved', async () => {
    expect(await (await serve(null, english)).json()).toEqual({ locale: 'en', tz: 'UTC' });
    const plain = userActor({ id: 'ana' });
    expect(await (await serve(plain, { 'accept-language': 'de' })).json()).toMatchObject({
      locale: 'de',
    });
  });
});
