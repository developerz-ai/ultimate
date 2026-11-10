// What an OAuth refusal publishes: an internal exception logged and never answered, and only the
// provider's OAuth error fields quoted. Split out of `oauth-route.test.ts` at the file ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, installLogSink } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import type { OAuthFetch } from './oauth-exchange';
import { oauthLogin } from './oauth-route';

const NOW = new Date('2026-08-15T12:00:00.000Z');

const SECRET = 'a'.repeat(32);

const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

let adapter: MemoryAuthAdapter;

let auth: Auth;

let logged: string[];

let releaseLogSink: () => void;

beforeEach(() => {
  adapter = memoryAuthAdapter();
  auth = defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github', 'google'] });
  logged = [];
  releaseLogSink = installLogSink((line) => {
    logged.push(line);
  });
});

afterEach(() => {
  releaseLogSink();
});

/** The developer's half of the last refusal: its cause and fix, where only an operator reads. */
const refused = (): string => logged.findLast((line) => line.includes('auth.oauth.refused')) ?? '';

/** The three GitHub calls a client-side login makes, and nothing else. */
const githubFetch = (): OAuthFetch => (input) => {
  if (input === 'https://github.com/login/oauth/access_token') {
    return Promise.resolve(Response.json({ access_token: 'gho_first', token_type: 'bearer' }));
  }
  if (input === 'https://api.github.com/user') {
    return Promise.resolve(Response.json({ id: 583231, login: 'ada', name: 'Ada Lovelace' }));
  }
  if (input === 'https://api.github.com/user/emails') {
    return Promise.resolve(
      Response.json([{ email: 'ada@example.com', primary: true, verified: true }]),
    );
  }
  return Promise.resolve(new Response('unexpected', { status: 500 }));
};

/** `name=value` — what a browser sends back, without the attributes it keeps to itself. */
const cookiePair = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

const bodyOf = async (response: Response): Promise<Record<string, unknown>> => {
  const parsed: unknown = await response.json();
  // Asserted, never thrown: a bare `Error` has no code and no fix, and this file has no more
  // licence to throw one than the package it drives.
  expect(parsed).toBeObject();
  return parsed as Record<string, unknown>;
};

/**
 * Two DIFFERENT leaks of the same shape, and only one of them is `problem()`'s uncoded branch.
 *
 *  1. an ADAPTER throwing a bare `Error` mid-callback reaches `problem()` with no code, and
 *     `publicBody` published `cause` — reproduced: `connect ECONNREFUSED 10.4.2.17:5432
 *     (postgres://app:hunter2@db.internal/prod)` served as the 502 body to whoever typed the URL;
 *  2. an injected `OAuthFetch` REJECTING is caught by `postForm` first and becomes a CODED
 *     `X_OAUTH_EXCHANGE_FAILED` whose cause already carried the rendered value, so it never
 *     reached branch 1 at all. Same disclosure, one layer earlier, on the leg that carries
 *     `client_secret`.
 *
 * `publicBody`'s own comment says a stack and `meta` must never reach that reader. The field
 * carrying the message was the exception nobody meant to make, in two places.
 */
describe('an internal exception is logged, never published', () => {
  const SECRETISH = 'connect ECONNREFUSED 10.4.2.17:5432 (postgres://app:hunter2@db.internal/x)';

  /** Drive both legs of a real callback and hand back the body it answered with. */
  const callbackBody = async (
    login: ReturnType<typeof oauthLogin>,
  ): Promise<Record<string, unknown>> => {
    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return bodyOf(
      await login.callback.handle(
        new Request(`https://app.test/auth/sso/github/callback?code=c&state=${state}`, {
          headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') },
        }),
      ),
    );
  };

  test('an adapter throwing a bare Error publishes a fixed sentence, not the throw', async () => {
    const hostile = new Proxy(adapter, {
      get(target, prop) {
        // REJECTED, never `throw`n from the fixture: a bare `Error` handed to the code under
        // test is legitimate input, but `scripts/test-bare-error.ts` reads a `throw` statement in
        // a test file as the test stating its own verdict, and a fixture must not spend the
        // package's ratchet. The value the callback produces is identical either way.
        if (prop === 'findAccount') return () => Promise.reject(new Error(SECRETISH));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const body = await callbackBody(
      oauthLogin(defineAuth({ adapter: hostile, clock: frozenClock(NOW), providers: ['github'] }), {
        credentials,
        fetch: githubFetch(),
        secret: SECRET,
        baseUrl: 'https://app.test',
      }),
    );

    expect(body['code']).toBe('X_OAUTH_EXCHANGE_FAILED');
    const rendered = JSON.stringify(body);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('ECONNREFUSED');
    expect(rendered).not.toContain('10.4.2.17');
    expect(Object.keys(body).sort()).toEqual(['cause', 'code', 'docs', 'fix', 'title']);
    // Not in the log line either: the throw's own text is under `auth.oauth.uncoded_failure`.
    expect(refused()).not.toContain('hunter2');
    expect(refused()).toContain('UltimateError');
  });

  test('a fetch that rejects is the same rule one layer earlier, on the secret-carrying leg', async () => {
    const body = await callbackBody(
      oauthLogin(auth, {
        credentials,
        secret: SECRET,
        baseUrl: 'https://app.test',
        // Rejected rather than thrown, for the reason above.
        fetch: () => Promise.reject(new Error(SECRETISH)),
      }),
    );

    expect(body['code']).toBe('X_OAUTH_EXCHANGE_FAILED');
    const rendered = JSON.stringify(body);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('ECONNREFUSED');
    // The URL and the remedy are framework constants: the logged failure must remain fixable.
    expect(refused()).not.toContain('hunter2');
    expect(refused()).toContain('https://github.com/login/oauth/access_token');
    expect(refused()).toContain('curl');
  });

  /** githubFetch, with one URL answered by `answer` instead. */
  const failingAt =
    (url: string, answer: () => Promise<Response>): OAuthFetch =>
    (input, init) =>
      input === url ? answer() : githubFetch()(input, init);

  test.each(['https://api.github.com/user', 'https://api.github.com/user/emails'])(
    'a rejected profile fetch (%s) publishes a fixed sentence, not the throw',
    async (url) => {
      const body = await callbackBody(
        oauthLogin(auth, {
          credentials,
          secret: SECRET,
          baseUrl: 'https://app.test',
          fetch: failingAt(url, () => Promise.reject(new Error(SECRETISH))),
        }),
      );
      expect(body['code']).toBe('X_OAUTH_EXCHANGE_FAILED');
      const rendered = JSON.stringify(body);
      expect(rendered).not.toContain('hunter2');
      expect(rendered).not.toContain('ECONNREFUSED');
      expect(rendered).not.toContain('10.4.2.17');
      expect(refused()).not.toContain('hunter2');
      expect(refused()).toContain('auth.oauth.userinfo_fetch_failed');
    },
  );
});

// The token leg carries `client_secret`. `message` is not an OAuth error field, and a gateway that
// echoes the request body puts the secret in it — so a `coded-only` leg reads only `error` and
// `error_description`, the two fields RFC 6749 §5.2 defines.
describe('the token leg quotes only the OAuth error fields', () => {
  const tokenAnswer =
    (body: unknown): OAuthFetch =>
    (input, init) =>
      input === 'https://github.com/login/oauth/access_token'
        ? Promise.resolve(Response.json(body, { status: 400 }))
        : githubFetch()(input, init);

  const callbackFor = async (fetch: OAuthFetch): Promise<Record<string, unknown>> => {
    const login = oauthLogin(auth, {
      credentials,
      fetch,
      secret: SECRET,
      baseUrl: 'https://app.test',
    });
    const start = await login.start.handle(new Request('https://app.test/auth/sso/github'));
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return bodyOf(
      await login.callback.handle(
        new Request(`https://app.test/auth/sso/github/callback?code=c&state=${state}`, {
          headers: { cookie: cookiePair(start.headers.getSetCookie()[0] ?? '') },
        }),
      ),
    );
  };

  test('an echoed request in `message` reaches neither the body nor the log', async () => {
    const body = await callbackFor(
      tokenAnswer({ message: 'bad request: client_id=client-id&client_secret=SECRET-VALUE-42' }),
    );
    expect(JSON.stringify(body)).not.toContain('SECRET-VALUE-42');
    expect(refused()).not.toBe('');
    expect(refused()).not.toContain('SECRET-VALUE-42');
  });

  test('an ordinary error_description is still logged — it is an OAuth field', async () => {
    const body = await callbackFor(
      tokenAnswer({ error: 'invalid_grant', error_description: 'The code has expired' }),
    );
    expect(JSON.stringify(body)).not.toContain('The code has expired');
    expect(refused()).toContain('The code has expired');
  });
});
