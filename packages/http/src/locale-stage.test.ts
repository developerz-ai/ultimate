// The `locale` stage's real contract: the request's zone and locale must reach the AMBIENT
// readers every renderer uses, not only `ctx`. `@ultimat3/time`'s `currentTimeZone()` read a
// context field this pipeline never wrote, so a server render formatted in UTC however the
// request arrived — the framework's loudest non-negotiable, satisfied in letter and wrong in fact.

import { describe, expect, test } from 'bun:test';
import { currentLocale } from '@ultimat3/i18n';
import { currentTimeZone, formatDateTime, fromIso } from '@ultimat3/time';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { json } from './response';
import { createRouter, type Route } from './router';

/** Fixed, so the assertion is a value — never a wall-clock comparison that drifts with the run. */
const AT = fromIso('2026-01-15T23:30:00Z');

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/ambient',
    meta: { name: 'ambient', auth: 'public' },
    // Exactly what `@ultimat3/ui`'s `ambientUiContext()` does on every server render.
    handler: (_request, ctx) =>
      json({
        // Both halves: `ctx` is what the stage wrote, the ambient readers are what a renderer
        // asks. A test that read only one cannot tell "never written" from "written wrong".
        ctxTz: ctx.tz,
        ctxLocale: ctx.locale,
        zone: currentTimeZone(),
        locale: currentLocale(),
        rendered: formatDateTime(AT, {
          locale: currentLocale(),
          zone: currentTimeZone(),
          dateStyle: 'short',
          timeStyle: 'short',
        }),
      }),
  },
];

const config = defineHttpConfig({
  rateLimit: { enabled: false, scope: 'process' },
  dev: false,
  buildId: null,
});

const pipeline = createPipeline({ table: createRouter(routes), config, hooks: {} });

const ask = async (headers: Record<string, string>): Promise<Record<string, unknown>> => {
  const response = await pipeline.handle(new Request('http://localhost/ambient', { headers }), {
    role: 'web',
  });
  return (await response.json()) as Record<string, unknown>;
};

describe('the locale stage feeds the ambient readers', () => {
  test('a request carrying a non-UTC zone renders in that zone', async () => {
    const body = await ask({ 'x-timezone': 'Asia/Tokyo' });

    expect(body['ctxTz']).toBe('Asia/Tokyo');
    expect(body['zone']).toBe('Asia/Tokyo');
    // 23:30Z on the 15th is 08:30 on the 16th in Tokyo: the DAY differs, so a UTC render
    // cannot accidentally satisfy this.
    expect(body['rendered']).toBe('1/16/26, 8:30 AM');
  });

  test('the same instant renders in UTC when the request names no zone', async () => {
    const body = await ask({});

    expect(body['zone']).toBe('UTC');
    expect(body['rendered']).toBe('1/15/26, 11:30 PM');
  });

  test('an `Accept-Language` the app supports reaches the ambient locale', async () => {
    const body = await ask({ 'accept-language': 'de-CH;q=0.9, en;q=0.5' });

    expect(body['ctxLocale']).toBe('de');
    expect(body['locale']).toBe('de');
  });

  test('a zone the header spells in another casing arrives canonical, never as its own string', async () => {
    // Every `Intl` formatter cache downstream keys on this value; `Intl` accepts all 2^12
    // casings of a 13-letter zone name and each one used to mint its own permanent entry.
    const body = await ask({ 'x-timezone': 'aSiA/tOkYo' });

    expect(body['ctxTz']).toBe('Asia/Tokyo');
    expect(body['zone']).toBe('Asia/Tokyo');
  });

  test('a fixed offset is not a zone, so it falls back rather than travelling the request', async () => {
    // `Intl` formats with `+01:00`; it has no DST rules, so every derived answer downstream is
    // wrong for half the year. `@ultimat3/time` is the one judge of what a zone is.
    const body = await ask({ 'x-timezone': '+01:00' });

    expect(body['ctxTz']).toBe('UTC');
    expect(body['zone']).toBe('UTC');
  });
});
