import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import { beginOAuth, type OAuthHandshake } from './oauth';
import {
  clearHandshakeCookie,
  DEFAULT_HANDSHAKE_TTL_MS,
  handshakeCookie,
  handshakeSecret,
  OAUTH_HANDSHAKE_COOKIE,
  openHandshake,
  readHandshakeCookie,
  sealHandshake,
} from './oauth-cookie';
import type { OAuthFetch } from './oauth-exchange';
import { completeOAuthLogin } from './oauth-login';

const NOW = new Date('2026-08-09T12:00:00.000Z');
const SECRET = 'a'.repeat(32);
const clock = frozenClock(NOW);
const options = { secret: SECRET, clock };

const start = (provider: 'github' | 'google' = 'github'): OAuthHandshake =>
  beginOAuth({ provider, clientId: 'client-id', redirectUri: 'https://app.test/auth/callback' });

/** The callback leg as it really arrives: a fresh request carrying only what the browser kept. */
const callbackRequest = (setCookie: string): Request =>
  new Request('https://app.test/auth/oauth/github/callback?code=the-code', {
    headers: { cookie: setCookie.slice(0, setCookie.indexOf(';')) },
  });

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('the handshake seal', () => {
  test('a sealed handshake opens back into the same handshake', () => {
    const handshake = start();
    expect(openHandshake(sealHandshake(handshake, options), 'github', options)).toEqual(handshake);
  });

  test('the PKCE verifier survives the round trip — without it the exchange proves nothing', () => {
    const handshake = start();
    const reopened = openHandshake(sealHandshake(handshake, options), 'github', options);
    expect(reopened.verifier).toBe(handshake.verifier);
    expect(reopened.verifier.length).toBeGreaterThanOrEqual(43);
    expect(reopened.nonce).toBe(handshake.nonce);
  });

  test('a handshake invented without the secret is refused', () => {
    // Login CSRF: an attacker who can mint a handshake pairs their own code with a victim's
    // browser, and the victim's session ends up holding the attacker's provider account.
    const forged = `${btoa(JSON.stringify(['github', 's', 'n', 'v', 'https://app.test', 'https://github.test', NOW.getTime()]))}.${'0'.repeat(64)}`;
    expect(codeOf(() => openHandshake(forged, 'github', options))).toBe('X_OAUTH_STATE_INVALID');
  });

  test('an edited payload is refused', () => {
    const sealed = sealHandshake(start(), options);
    const dot = sealed.lastIndexOf('.');
    const tampered = `${sealed.slice(0, dot - 1)}${sealed[dot - 1] === 'A' ? 'B' : 'A'}${sealed.slice(dot)}`;
    expect(codeOf(() => openHandshake(tampered, 'github', options))).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a handshake signed with another secret is refused', () => {
    const sealed = sealHandshake(start(), { ...options, secret: 'b'.repeat(32) });
    expect(codeOf(() => openHandshake(sealed, 'github', options))).toBe('X_OAUTH_STATE_INVALID');
  });

  test('a github handshake cannot finish a google callback', () => {
    const sealed = sealHandshake(start('github'), options);
    expect(codeOf(() => openHandshake(sealed, 'google', options))).toBe('X_OAUTH_STATE_INVALID');
  });

  test('an unsigned or unreadable value is refused rather than parsed', () => {
    expect(codeOf(() => openHandshake('not-signed', 'github', options))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
    const body = btoa('{"not":"an array"}').replaceAll('=', '');
    const secret = SECRET;
    const signature = new Bun.CryptoHasher('sha256', secret).update(body).digest('hex');
    expect(codeOf(() => openHandshake(`${body}.${signature}`, 'github', options))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
  });

  test('the age that decides is the server clock, not the cookie the client kept', () => {
    const sealed = sealHandshake(start(), options);
    const late = frozenClock(new Date(NOW.getTime() + DEFAULT_HANDSHAKE_TTL_MS + 1));
    expect(codeOf(() => openHandshake(sealed, 'github', { secret: SECRET, clock: late }))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
    const inTime = frozenClock(new Date(NOW.getTime() + DEFAULT_HANDSHAKE_TTL_MS - 1));
    expect(openHandshake(sealed, 'github', { secret: SECRET, clock: inTime }).provider).toBe(
      'github',
    );
  });
});

describe('the handshake cookie', () => {
  test('every attribute the browser is trusted to enforce is set', () => {
    const cookie = handshakeCookie(start(), options);
    expect(cookie.startsWith(`${OAUTH_HANDSHAKE_COOKIE}=`)).toBe(true);
    // `__Host-` is only honoured with Path=/ and no Domain; Lax is what a top-level cross-site
    // GET back from the provider still carries, and HttpOnly keeps an XSS off the verifier.
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain('Domain=');
  });

  test('Max-Age tracks the ttl the server will enforce', () => {
    expect(handshakeCookie(start(), { ...options, ttlMs: 120_000 })).toContain('Max-Age=120');
  });

  test('clearing it matches the attribute set that set it', () => {
    const cleared = clearHandshakeCookie();
    expect(cleared).toContain('Max-Age=0');
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(cleared).toContain(attribute);
    }
  });

  test('a callback with no handshake cookie is refused', () => {
    const request = new Request('https://app.test/auth/oauth/github/callback');
    expect(codeOf(() => readHandshakeCookie(request, 'github', options))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
  });

  test('the handshake is found among the other cookies on the request', () => {
    const handshake = start();
    const sealed = sealHandshake(handshake, options);
    const request = new Request('https://app.test/auth/oauth/github/callback', {
      headers: { cookie: `theme=dark; ${OAUTH_HANDSHAKE_COOKIE}=${sealed}; __Host-x_session=abc` },
    });
    expect(readHandshakeCookie(request, 'github', options)).toEqual(handshake);
  });
});

describe('handshakeSecret', () => {
  test('an unset SESSION_SECRET names the key and a runnable fix', () => {
    let thrown: unknown;
    try {
      handshakeSecret({});
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_ENV_MISSING');
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain('SESSION_SECRET');
  });

  test('a secret too short to be one is refused, not quietly used', () => {
    expect(codeOf(() => handshakeSecret({ SESSION_SECRET: 'short' }))).toBe('X_ENV_MISSING');
    expect(handshakeSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('the two legs of a login', () => {
  /**
   * The point of the whole file: the redirect and the callback are separate requests, and the
   * only thing that crosses between them is the cookie. Nothing here hands the handshake over
   * in a variable, because a real callback cannot.
   */
  test('a github login finishes across two requests carrying only the cookie', async () => {
    const auth: Auth = defineAuth({
      adapter: new MemoryAdapter(),
      clock,
      providers: ['github', 'google'],
    });

    // Leg one: GET /auth/oauth/github — redirect the browser, keep nothing on the server.
    const redirect = handshakeCookie(start(), options);

    // Leg two: GET /auth/oauth/github/callback — a new request, a new process for all we know.
    const request = callbackRequest(redirect);
    const handshake = readHandshakeCookie(request, 'github', options);
    const url = new URL(request.url);

    let sentVerifier: string | null = null;
    const fetch: OAuthFetch = async (endpoint, init) => {
      if (endpoint === 'https://github.com/login/oauth/access_token') {
        sentVerifier = new URLSearchParams(String(init.body)).get('code_verifier');
        return json({ access_token: 'gho_token', token_type: 'bearer' });
      }
      if (endpoint === 'https://api.github.com/user') return json({ id: 583231, login: 'octocat' });
      if (endpoint === 'https://api.github.com/user/emails') {
        return json([{ email: 'ada@example.com', primary: true, verified: true }]);
      }
      return expect.unreachable(`unexpected endpoint: ${endpoint}`);
    };

    const result = await completeOAuthLogin(auth, {
      handshake,
      callback: { state: handshake.state, code: url.searchParams.get('code') ?? '' },
      credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
      fetch,
    });

    expect(result.actor.kind).toBe('user');
    expect(result.cookie).toContain('__Host-x_session=');
    // The verifier reached the token endpoint from the cookie alone — that is what PKCE is.
    expect(sentVerifier).toBe(handshake.verifier);
  });

  test('a callback whose cookie belongs to another browser never reaches the network', async () => {
    const auth: Auth = defineAuth({ adapter: new MemoryAdapter(), clock, providers: ['github'] });
    const victim = start();
    const attacker = start();
    const request = callbackRequest(handshakeCookie(victim, options));
    const handshake = readHandshakeCookie(request, 'github', options);

    const fetch: OAuthFetch = async (endpoint) =>
      expect.unreachable(`the exchange must not run: ${endpoint}`);

    let thrown: unknown;
    try {
      await completeOAuthLogin(auth, {
        handshake,
        // The state the attacker put on the redirect URL, against the victim's stored handshake.
        callback: { state: attacker.state, code: 'the-attackers-code' },
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' },
        fetch,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : thrown).toBe('X_OAUTH_STATE_INVALID');
  });
});
