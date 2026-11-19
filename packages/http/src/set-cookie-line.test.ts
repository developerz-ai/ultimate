// `setCookie(line)`: a line `serializeSetCookie` already built — what `@ultimat3/auth` hands back —
// goes on the response as it is, and anything else is refused before it reaches the header bag.
import { describe, expect, test } from 'bun:test';
import {
  ctxOf,
  runWithContext,
  type SetCookieOptions,
  serializeSetCookie,
  UltimateError,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { asCtx, requestContext } from './context';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter } from './router';
import { setCookie } from './set-cookie';

const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null });
const TOKEN = 'sess_1.c2VjcmV0LXZhbHVl';
const SESSION = serializeSetCookie('__Host-x_session', TOKEN, { maxAge: 3600 });

const context = () =>
  requestContext({ url: new URL('https://example.com/'), method: 'GET', role: 'web', config });

const inRequest = (fn: () => void): readonly string[] => {
  const ctx = context();
  runWithContext(asCtx(ctx), fn);
  return ctx.headers.getSetCookie();
};

/** The refusal `setCookie(line)` raises, and what reached the header bag beside it. */
const refusalOf = (line: string) => {
  const ctx = context();
  try {
    runWithContext(asCtx(ctx), () => setCookie(line));
  } catch (error) {
    if (error instanceof UltimateError) {
      return { code: error.code, text: `${error.cause} ${error.fix}`, sent: ctx.headers };
    }
    throw error;
  }
  return { code: 'did not throw', text: '', sent: ctx.headers };
};

describe('setCookie(line)', () => {
  test('a session line reaches the wire byte for byte, beside a cookie set by name', async () => {
    const pipeline = httpPipeline({
      config,
      table: httpRouter([
        {
          method: 'GET',
          path: '/both',
          meta: { name: 'both', auth: 'public' },
          handler: () => {
            setCookie(SESSION);
            setCookie('theme', 'dark');
            return textResponse('ok');
          },
        },
      ]),
    });
    const response = await pipeline.handle(new Request('http://localhost/both'), { role: 'web' });
    expect(response.headers.getSetCookie()).toEqual([
      SESSION,
      'theme=dark; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  const SERIALIZED: readonly (readonly [string, string, SetCookieOptions])[] = [
    ['plain', 'v', {}],
    ['encoded', 'a b;c%', {}],
    ['empty', '', {}],
    ['loose', 'v', { httpOnly: false, secure: false, sameSite: 'Strict', path: '/app' }],
    ['aged', 'v', { maxAge: 60, expires: new Date('2999-01-02T03:04:05Z') }],
    ['scoped', 'v', { domain: 'example.com', partitioned: true, priority: 'High' }],
    ['none', 'v', { sameSite: 'None' }],
  ];

  test.each(SERIALIZED)('every line the serializer writes is accepted: %s', (name, value, opts) => {
    const line = serializeSetCookie(name, value, opts);
    expect(inRequest(() => setCookie(line))).toEqual([line]);
  });

  test('a rotated session at its ceiling keeps its Max-Age=0 line', () => {
    const line = serializeSetCookie('__Host-x_session', TOKEN, { maxAge: 0 });
    expect(inRequest(() => setCookie(line))).toEqual([line]);
  });

  const NOT_SERIALIZED: readonly (readonly [string, string])[] = [
    ['no attributes', 'sid=abc'],
    ['no name', `=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax`],
    ['no pair at all', TOKEN],
    ['the empty string', ''],
    ['a name that is not a token', 'bad name=v; Path=/; HttpOnly; Secure; SameSite=Lax'],
    ['a value left unencoded', 'sid=a b; Path=/; HttpOnly; Secure; SameSite=Lax'],
    ['a stray percent', 'sid=%; Path=/; HttpOnly; Secure; SameSite=Lax'],
    ['a header smuggled after the value', `${SESSION}\r\nX-Evil: 1`],
    ['a line feed inside the pair', 'sid=a\n; Path=/; HttpOnly; Secure; SameSite=Lax'],
    ['an attribute it never writes', `${SESSION}; Evil=1`],
    ['a repeated attribute', `${SESSION}; Path=/`],
    ['attributes out of order', 'sid=v; HttpOnly; Path=/; Secure; SameSite=Lax'],
    ['an attribute in another case', 'sid=v; path=/; HttpOnly; Secure; SameSite=Lax'],
    ['a Max-Age that is not its digits', 'sid=v; Max-Age=1e3; Path=/; Secure; SameSite=Lax'],
    ['an unknown SameSite', 'sid=v; Path=/; Secure; SameSite=Sometimes'],
    ['an unreadable Expires', 'sid=v; Expires=soon; Path=/; Secure; SameSite=Lax'],
    ['a __Host- cookie with a Domain', '__Host-s=v; Domain=a.io; Path=/; Secure; SameSite=Lax'],
  ];

  test.each(NOT_SERIALIZED)('refused, with nothing appended: %s', (_label, line) => {
    const { code, sent } = refusalOf(line);
    expect(code).toBe('X_COOKIE_INVALID');
    expect(sent.getSetCookie()).toEqual([]);
  });

  test('the refusal never repeats the line: it may hold a live session token', () => {
    for (const line of [TOKEN, `${SESSION}; Evil=1`, `bad ${TOKEN}=v; Path=/`]) {
      const { code, text } = refusalOf(line);
      expect(code).toBe('X_COOKIE_INVALID');
      expect(text).not.toContain(TOKEN);
    }
  });

  test('a missing line is refused: `updatePrivileges` answers no cookie when nothing rotated', () => {
    const { code } = refusalOf(undefined as unknown as string);
    expect(code).toBe('X_COOKIE_INVALID');
  });

  test('a clearing line is refused: deleteCookie stays the one way to clear', () => {
    const { code, text, sent } = refusalOf(serializeSetCookie('sid', '', { maxAge: 0 }));
    expect(code).toBe('X_COOKIE_INVALID');
    expect(text).toContain('deleteCookie(');
    expect(sent.getSetCookie()).toEqual([]);
  });

  test('an Expires already past is refused for the same reason', () => {
    const { code, text } = refusalOf(serializeSetCookie('sid', 'v', { expires: new Date(0) }));
    expect(code).toBe('X_COOKIE_INVALID');
    expect(text).toContain('deleteCookie(');
  });

  test('outside a request it refuses, as the named form does', () => {
    const job = ctxOf({ role: 'worker' });
    let code = 'did not throw';
    try {
      runWithContext(job, () => setCookie(SESSION));
    } catch (error) {
      if (error instanceof UltimateError) code = error.code;
    }
    expect(code).toBe('X_NO_REQUEST');
  });
});
