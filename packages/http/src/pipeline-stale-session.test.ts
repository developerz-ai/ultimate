// A stale session cookie is an anonymous visitor, not an error page. `@ultimat3/auth`'s
// `authenticate()` THROWS for a revoked, expired or forged cookie, and an app authenticator that let
// it through answered 401 on every route — sign-in, the OAuth callback and sign-out included — for
// as long as the browser kept the cookie (its Max-Age outlives the idle expiry by weeks).

import { describe, expect, test } from 'bun:test';
import { type Actor, isAnonymous, UltimateError, userActor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter, type Route } from './router';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/private',
    meta: { name: 'private', auth: 'required' },
    handler: () => textResponse('ok'),
  },
  {
    method: 'GET',
    path: '/sign-in',
    meta: { name: 'sign-in', auth: 'public' },
    handler: (_request, ctx) => textResponse(isAnonymous(ctx.actor) ? 'anonymous' : 'signed in'),
  },
];

const coded = (code: string): UltimateError =>
  new UltimateError({ code, cause: `a test ${code}`, fix: 'sign in again' });

/** The throwing shape every `x new` app shipped: auth's own refusal, let through. */
const authenticate = (request: { cookie(name: string): string | null }): Actor | null => {
  const sid = request.cookie('sid');
  if (sid === null) return null;
  if (sid === 'live') return userActor({ id: 'u1' });
  if (sid === 'expired') throw coded('X_SESSION_EXPIRED');
  if (sid === 'down') throw coded('X_DB_UNAVAILABLE');
  throw coded('X_UNAUTHENTICATED');
};

const pipeline = httpPipeline({
  table: httpRouter(routes),
  config: defineHttpConfig({ dev: false, buildId: null, rateLimit: { enabled: false } }),
  hooks: { authenticate },
});

const ask = (path: string, sid?: string): Promise<Response> =>
  pipeline.handle(
    new Request(`http://localhost${path}`, {
      headers: {
        accept: 'application/json',
        ...(sid === undefined ? {} : { cookie: `sid=${sid}` }),
      },
    }),
    { role: 'web', ip: '203.0.113.9' },
  );

/** The parts of a refusal a client reads; a request id differs per answer by design. */
const refusal = async (response: Response) => {
  const body = (await response.json()) as { code: string; cause: string; fix: string };
  return { status: response.status, code: body.code, cause: body.cause, fix: body.fix };
};

describe('a stale session cookie on a public route', () => {
  test.each(['revoked', 'expired'])('a %s cookie is served as anonymous, 200', async (sid) => {
    const response = await ask('/sign-in', sid);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('anonymous');
  });

  test('a live cookie is still its user', async () => {
    expect(await (await ask('/sign-in', 'live')).text()).toBe('signed in');
  });

  // A database blip is not "nobody": it must not quietly serve a signed-in user as anonymous.
  test('any other throw is still a failure, never anonymous', async () => {
    const response = await ask('/sign-in', 'down');
    expect(response.status).not.toBe(200);
    expect(((await response.json()) as { code: string }).code).toBe('X_DB_UNAVAILABLE');
  });
});

describe('a stale session cookie on a protected route', () => {
  test.each(['revoked', 'expired'])('a %s cookie is the same 401 as no cookie', async (sid) => {
    const stale = await refusal(await ask('/private', sid));
    expect(stale.status).toBe(401);
    expect(stale).toEqual(await refusal(await ask('/private')));
  });
});
