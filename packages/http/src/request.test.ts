// `UltimateRequest` is the only door a handler has to params, query and body, so whatever it
// mis-parses or lets past the size limit is beyond the reach of any later check. These tests
// pin the parse and the refusal together: every rejection has to arrive as an HttpError
// carrying a code and a cause, never as a raw throw from the runtime.

import { describe, expect, test } from 'bun:test';
import { localeConfig } from '@ultimat3/i18n';
import { t } from '@ultimat3/schema';
import { timeConfig } from '@ultimat3/time';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { requestContext } from './context';
import { HttpError } from './errors';
import { UltimateRequest } from './request';

/** One request/context/config triple per test, built consistently. */
const build = (
  urlString: string,
  requestInit: RequestInit = {},
  configInput: HttpConfigInput = {},
) => {
  const url = new URL(urlString);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, ...configInput });
  const ctx = requestContext({
    url,
    method: (requestInit.method ?? 'GET').toString(),
    role: 'web',
    config,
  });
  const raw = new Request(url, requestInit);
  return { req: new UltimateRequest(raw, ctx), ctx, config, raw, url };
};

/**
 * Captures the HttpError a call is expected to throw. A call that does not throw leaves the
 * capture `undefined`, which fails the caller's `?.code` assertion — an unexpected success is
 * a bug, not a pass. Anything that is not an HttpError is rethrown rather than reported as a
 * missing code, so the real failure reaches the runner intact.
 */
const captureError = async (run: () => Promise<unknown>): Promise<HttpError | undefined> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
};

const captureSyncError = (run: () => unknown): HttpError | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
};

describe('getters', () => {
  test('delegate to ctx and raw for a plain GET', () => {
    const { req, ctx, raw, url } = build('https://example.com/posts/1?x=1');
    ctx.params = { id: '1' };

    expect(req.method).toBe('GET');
    expect(req.url).toBe(url);
    expect(req.pathname).toBe('/posts/1');
    expect(req.headers).toBe(raw.headers);
    expect(req.params).toEqual({ id: '1' });
    expect(req.actor).toEqual(ctx.actor);
    expect(req.locale).toBe(localeConfig().fallback);
    expect(req.tz).toBe(timeConfig().defaultZone);
    expect(req.requestId).toBe(ctx.requestId);
    expect(req.buildId).toBeNull();
  });

  test('method is uppercased, matching what requestContext already normalised', () => {
    const url = new URL('https://example.com/x');
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
    });
    const ctx = requestContext({ url, method: 'get', role: 'web', config });
    const req = new UltimateRequest(new Request(url), ctx);
    expect(req.method).toBe('GET');
  });

  test('headers come from raw, not from ctx', () => {
    const { req, ctx, raw } = build('https://example.com/x', {
      headers: { 'x-test': 'yes' },
    });
    expect(req.headers.get('x-test')).toBe('yes');
    expect(req.headers).toBe(raw.headers);
    expect(req.headers).not.toBe(ctx.headers);
  });

  test('buildId reflects ctx.clientBuildId once the client sends one', () => {
    const { req, ctx } = build('https://example.com/x');
    ctx.clientBuildId = 'client-9';
    expect(req.buildId).toBe('client-9');
  });
});

describe('header()', () => {
  test('returns the raw header value, or null when absent', () => {
    const { req } = build('https://example.com/x', { headers: { 'x-foo': 'bar' } });
    expect(req.header('x-foo')).toBe('bar');
    expect(req.header('x-missing')).toBeNull();
  });
});

// `hooks.authenticate` is handed this object and nothing else, so this is the only seam a
// session lookup has. Without it every app rolls its own `Cookie` split — a second parser for
// a header whose escaping rules the framework already knows.
describe('cookie()', () => {
  const cookies = (header: string) =>
    build('https://example.com/x', { headers: { cookie: header } }).req;

  test('reads one cookie out of the header and url-decodes it', () => {
    const req = cookies('x-locale=de; session=a%20b; theme=dark');
    expect(req.cookie('session')).toBe('a b');
    expect(req.cookie('theme')).toBe('dark');
  });

  test('an absent cookie, and a request with no Cookie header at all, read null', () => {
    expect(cookies('theme=dark').cookie('session')).toBeNull();
    expect(build('https://example.com/x').req.cookie('session')).toBeNull();
  });

  test('a name that is only a prefix of another cookie does not match it', () => {
    expect(cookies('session_id=nope').cookie('session')).toBeNull();
  });
});

describe('param()', () => {
  test('returns the matched route param', () => {
    const { req, ctx } = build('https://example.com/posts/42');
    ctx.params = { id: '42' };
    expect(req.param('id')).toBe('42');
  });

  test('a missing param throws X_BODY_INVALID naming the :segment', () => {
    const { req, ctx } = build('https://example.com/posts/42');
    ctx.params = { id: '42' };
    expect(() => req.param('missing')).toThrow();

    const error = captureSyncError(() => req.param('missing'));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause).toContain('missing');
    expect(error?.cause).toContain(':missing');
  });
});

describe('body()', () => {
  test('a valid body parses through a real schema', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ada' }),
    });
    const schema = t.object({ name: t.string });
    expect(await req.body(schema)).toEqual({ name: 'ada' });
  });

  test('an invalid body throws X_BODY_INVALID with the schema issues', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 }),
    });
    const schema = t.object({ name: t.string });
    const error = await captureError(() => req.body(schema));
    expect(error?.code).toBe('X_BODY_INVALID');
    expect(error?.cause.length).toBeGreaterThan(0);
  });
});

describe('assertBuild()', () => {
  test('does nothing when the server has no buildId configured', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: null });
    ctx.clientBuildId = 'client-1';
    expect(() => req.assertBuild()).not.toThrow();
  });

  test('does nothing when the client sent no buildId', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: 'server-1' });
    expect(ctx.clientBuildId).toBeNull();
    expect(() => req.assertBuild()).not.toThrow();
  });

  test('does nothing when client and server build ids match', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: 'server-1' });
    ctx.clientBuildId = 'server-1';
    expect(() => req.assertBuild()).not.toThrow();
  });

  test('throws X_BUILD_SKEW naming both ids when they differ', () => {
    const { req, ctx } = build('https://example.com/x', {}, { buildId: 'server-1' });
    ctx.clientBuildId = 'client-2';
    const error = captureSyncError(() => req.assertBuild());
    expect(error?.code).toBe('X_BUILD_SKEW');
    expect(error?.cause).toContain('client-2');
    expect(error?.cause).toContain('server-1');
  });
});
