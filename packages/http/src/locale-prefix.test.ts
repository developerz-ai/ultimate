// Locale prefix routing through the real pipeline: the prefix is stripped before the match, it
// outranks every other source, the default's own prefix redirects, and a `path`-locale route never
// negotiates. Failure cases first — an unmatched prefixed path must still be a 404.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { json } from './response';
import { createRouter, type Route } from './router';

const echo: Route['handler'] = (_request, ctx) =>
  json({ locale: ctx.locale, path: ctx.url.pathname });

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/precios',
    meta: { name: 'site:precios', auth: 'public', localeSource: 'path' },
    handler: (_request, ctx) => {
      const response = json({ locale: ctx.locale, path: ctx.url.pathname });
      response.headers.set('cache-control', 'public, max-age=0, must-revalidate');
      return response;
    },
  },
  {
    method: 'GET',
    path: '/',
    meta: { name: 'site:home', auth: 'public', localeSource: 'path' },
    handler: echo,
  },
  { method: 'GET', path: '/panel', meta: { name: 'app:panel', auth: 'public' }, handler: echo },
];

const config = defineHttpConfig({
  rateLimit: { enabled: false, scope: 'process' },
  dev: false,
  buildId: null,
});

beforeAll(() => configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' }));
afterAll(() => resetLocaleConfig());

const pipeline = () => createPipeline({ table: createRouter(routes), config, hooks: {} });

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  pipeline().handle(new Request(`http://localhost${path}`, { headers, method }), { role: 'web' });

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('locale prefix — refusals', () => {
  test('a prefix naming no configured locale is an ordinary path: /fr/x is 404', async () => {
    const response = await get('/fr/precios', { accept: 'application/json' });
    expect(response.status).toBe(404);
  });

  test('a configured prefix in front of an unmatched path is still 404', async () => {
    const response = await get('/en/nothing-here', { accept: 'application/json' });
    expect(response.status).toBe(404);
  });

  test('the default locale prefix is a duplicate URL: 301 to the unprefixed path, query kept', async () => {
    const response = await get('/es-co/precios?plan=pro');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/precios?plan=pro');
  });

  test('a non-GET on the default prefix is a 308, never a method-changing 301', async () => {
    const response = await get('/es-co/precios', {}, 'POST');
    expect(response.status).toBe(308);
  });

  test('a path-locale route never negotiates: / with Accept-Language: en is the default', async () => {
    const response = await get('/', { 'accept-language': 'en' });
    expect((await body(response))['locale']).toBe('es-co');
  });

  test('a path-locale route ignores the cookie and the query too', async () => {
    const response = await get('/precios?locale=en', { cookie: 'x_locale=en' });
    expect((await body(response))['locale']).toBe('es-co');
  });
});

describe('locale prefix — routing', () => {
  test('/en/precios is the /precios route, in en', async () => {
    const response = await get('/en/precios');
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ locale: 'en', path: '/en/precios' });
    expect(response.headers.get('content-language')).toBe('en');
  });

  test('/en and /en/ are the root in en', async () => {
    expect((await body(await get('/en')))['locale']).toBe('en');
    expect((await body(await get('/en/')))['locale']).toBe('en');
  });

  test('the prefix outranks query, cookie and header on a request-locale route', async () => {
    const response = await get('/en/panel?locale=es-co', {
      cookie: 'x_locale=es-co',
      'accept-language': 'es-CO',
    });
    expect((await body(response))['locale']).toBe('en');
  });

  test('an unprefixed request-locale route keeps query → cookie → user → header', async () => {
    expect((await body(await get('/panel', { 'accept-language': 'en' })))['locale']).toBe('en');
    expect(
      (await body(await get('/panel?locale=es-co', { 'accept-language': 'en' })))['locale'],
    ).toBe('es-co');
  });

  test('a path-locale response does not Vary on accept-language', async () => {
    const response = await get('/precios');
    const vary = response.headers.get('vary') ?? '';
    expect(vary.toLowerCase()).not.toContain('accept-language');
    expect(vary.toLowerCase()).toContain('cookie');
  });
});
