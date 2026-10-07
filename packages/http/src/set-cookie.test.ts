// `setCookie` / `deleteCookie` land on the response through the context's one header bag, through
// core's one serializer. Pinned end to end through the pipeline — the `response` stage's append is
// the half that decides whether two cookies reach the browser as two lines or as one.
import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter, type Route } from './router';
import { deleteCookie, setCookie } from './set-cookie';

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });

const route = (path: string, handler: () => void): Route => ({
  method: 'GET',
  path,
  meta: { name: path.slice(1), auth: 'public' },
  handler: () => {
    handler();
    return textResponse('ok');
  },
});

const routes: readonly Route[] = [
  route('/one', () => setCookie('theme', 'dark')),
  route('/many', () => {
    setCookie('theme', 'dark', { httpOnly: false });
    setCookie('seen', '1', { maxAge: 3600, sameSite: 'Strict' });
  }),
  route('/twice', () => {
    setCookie('theme', 'dark', { path: '/a' });
    setCookie('theme', 'light', { path: '/b' });
  }),
  route('/delete', () => deleteCookie('theme', { path: '/app', domain: 'example.com' })),
  route('/delete-default', () => deleteCookie('theme')),
];

const pipeline = httpPipeline({ table: httpRouter(routes), config });

const cookiesOf = async (path: string): Promise<readonly string[]> =>
  (await pipeline.handle(new Request(`http://localhost${path}`), { role: 'web' })).headers
    .getSetCookie()
    .slice();

const inRequest = (fn: () => void) => {
  const ctx = requestContext({
    url: new URL('https://example.com/'),
    method: 'GET',
    role: 'web',
    config,
  });
  runWithContext(asCtx(ctx), fn);
  return ctx.headers.getSetCookie();
};

const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof UltimateError ? error.code : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('setCookie', () => {
  test("one cookie is one Set-Cookie line, core's defaults applied", async () => {
    expect(await cookiesOf('/one')).toEqual(['theme=dark; Path=/; HttpOnly; Secure; SameSite=Lax']);
  });

  test('many cookies are many lines, in the order they were set', async () => {
    expect(await cookiesOf('/many')).toEqual([
      'theme=dark; Path=/; Secure; SameSite=Lax',
      'seen=1; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict',
    ]);
  });

  test('the same name twice APPENDS — two paths are two cookies, never an overwrite', async () => {
    expect(await cookiesOf('/twice')).toEqual([
      'theme=dark; Path=/a; HttpOnly; Secure; SameSite=Lax',
      'theme=light; Path=/b; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  test('a value is encoded by the one serializer, so it reads back exactly', () => {
    expect(inRequest(() => setCookie('q', 'a b;c'))).toEqual([
      'q=a%20b%3Bc; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  test("an invalid cookie is core's X_COOKIE_INVALID, and nothing is appended", () => {
    const ctx = requestContext({
      url: new URL('https://example.com/'),
      method: 'GET',
      role: 'web',
      config,
    });
    expect(codeOf(() => runWithContext(asCtx(ctx), () => setCookie('bad name', 'x')))).toBe(
      'X_COOKIE_INVALID',
    );
    expect(ctx.headers.getSetCookie()).toEqual([]);
  });

  test('maxAge: 0 is refused — deleteCookie is the one way to clear a cookie', () => {
    let fix = '';
    try {
      inRequest(() => setCookie('theme', '', { maxAge: 0 }));
    } catch (error) {
      if (error instanceof UltimateError) fix = `${error.code} ${error.fix}`;
    }
    expect(fix).toStartWith('X_COOKIE_INVALID');
    expect(fix).toContain('deleteCookie(');
  });

  test('an expires at or before now is refused for the same reason', () => {
    expect(codeOf(() => inRequest(() => setCookie('theme', 'x', { expires: new Date(0) })))).toBe(
      'X_COOKIE_INVALID',
    );
    const future = new Date(Date.now() + 86_400_000);
    expect(inRequest(() => setCookie('theme', 'x', { expires: future }))).toHaveLength(1);
  });

  test('outside a request it refuses rather than setting a cookie nobody will receive', () => {
    expect(codeOf(() => setCookie('theme', 'dark'))).toBe('X_NO_CONTEXT');
    const job = ctxOf({ role: 'worker' });
    expect(codeOf(() => runWithContext(job, () => setCookie('theme', 'dark')))).toBe(
      'X_NO_REQUEST',
    );
  });
});

describe('deleteCookie', () => {
  test('an empty value and Max-Age=0, on the SAME Path and Domain the cookie was set with', async () => {
    expect(await cookiesOf('/delete')).toEqual([
      'theme=; Max-Age=0; Domain=example.com; Path=/app; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  test('with no options it clears the cookie setCookie wrote with none', async () => {
    expect(await cookiesOf('/delete-default')).toEqual([
      'theme=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  test('a __Host- cookie can be deleted — the prefix rules still hold on the clearing line', () => {
    expect(inRequest(() => deleteCookie('__Host-sid'))).toEqual([
      '__Host-sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  test('outside a request it refuses too', () => {
    const job = ctxOf({ role: 'worker' });
    expect(codeOf(() => runWithContext(job, () => deleteCookie('theme')))).toBe('X_NO_REQUEST');
  });
});
