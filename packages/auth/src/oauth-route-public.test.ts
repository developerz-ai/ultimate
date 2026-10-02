// What the two OAuth legs answer a stranger with, and where the redirect_uri comes from. Both legs
// are public by definition, so the body is the code and one fixed sentence; the cause and the fix
// a developer needs are in the log. Split from `oauth-route.test.ts` at the 500-line ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, setLogSink } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import { handshakeSecret } from './oauth-cookie';
import { oauthLogin } from './oauth-route';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const SECRET = 'a'.repeat(32);
const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

let auth: Auth;
let lines: string[];
let previous: ReturnType<typeof setLogSink>;

beforeEach(() => {
  auth = defineAuth({
    adapter: new MemoryAdapter(),
    clock: frozenClock(NOW),
    providers: ['github'],
  });
  lines = [];
  previous = setLogSink((line) => {
    lines.push(line);
  });
});

afterEach(() => {
  setLogSink(previous);
});

const bodyOf = async (response: Response): Promise<Record<string, unknown>> => {
  const parsed: unknown = await response.json();
  expect(parsed).toBeObject();
  return parsed as Record<string, unknown>;
};

const refusedLine = (): string => lines.find((line) => line.includes('auth.oauth.refused')) ?? '';

describe('the body a stranger reads is the code and a fixed sentence', () => {
  const login = (): ReturnType<typeof oauthLogin> =>
    oauthLogin(auth, { credentials, secret: SECRET, baseUrl: 'https://app.test' });

  test('two different refusals of one code answer byte-identical bodies', async () => {
    const declined = async (reason: string): Promise<string> =>
      await (
        await login().callback.handle(
          new Request(
            `https://app.test/auth/oauth/github/callback?error=${reason}&error_description=${reason}-text`,
          ),
        )
      ).text();
    const first = await declined('access_denied');
    expect(first).toBe(await declined('interaction_required'));
    expect(first).not.toContain('access_denied');
  });

  test('the cause and the fix go to the log, under one event', async () => {
    const response = await login().callback.handle(
      new Request('https://app.test/auth/oauth/github/callback?code=the-code&state=forged'),
    );
    const body = await bodyOf(response);
    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: 'X_OAUTH_STATE_INVALID',
      title: body['title'],
      cause:
        'the sign-in was refused; its cause and its fix are in this server’s log under auth.oauth.refused',
      fix: 'x errors explain X_OAUTH_STATE_INVALID --json',
      docs: body['docs'],
    });
    expect(String(body['title'])).not.toBe('');
    // The developer's two lines are where only an operator reads them.
    expect(refusedLine()).toContain('X_OAUTH_STATE_INVALID');
    expect(refusedLine()).toContain('GET /auth/oauth/github');
  });

  test('a short SESSION_SECRET is refused without its length, in the body or the cause', async () => {
    const short = 'k'.repeat(17);
    const response = await oauthLogin(auth, {
      credentials,
      baseUrl: 'https://app.test',
      env: { SESSION_SECRET: short },
    }).start.handle(new Request('https://app.test/auth/oauth/github'));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('17');

    let cause = 'did-not-throw';
    try {
      handshakeSecret({ SESSION_SECRET: short });
    } catch (error) {
      cause = String((error as { cause?: unknown }).cause);
    }
    // How long the configured secret is narrows a guess; that it is too short is the whole fact.
    expect(cause).not.toContain('17');
    expect(cause).toContain('32');
  });
});

describe('redirect_uri is built from a declared origin, never from the Host header', () => {
  test('with neither baseUrl nor APP_URL the start leg refuses, whatever the Host says', async () => {
    const response = await oauthLogin(auth, { credentials, secret: SECRET, env: {} }).start.handle(
      new Request('https://attacker.test/auth/oauth/github'),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
    expect((await bodyOf(response))['code']).toBe('X_ENV_MISSING');
    expect(refusedLine()).toContain('APP_URL');
  });

  test('an unknown provider answers that same refusal, so the gap is not an oracle', async () => {
    const routes = oauthLogin(auth, { credentials, secret: SECRET, env: { APP_URL: '  ' } });
    const known = await routes.start.handle(new Request('https://app.test/auth/oauth/github'));
    const unknown = await routes.start.handle(new Request('https://app.test/auth/oauth/nope'));
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
  });

  test.each([
    ['APP_URL', { env: { APP_URL: 'https://app.test/' } }],
    ['baseUrl', { baseUrl: 'https://app.test', env: {} }],
    ['baseUrl over APP_URL', { baseUrl: 'https://app.test', env: { APP_URL: 'https://b.test' } }],
  ])('%s names the origin, and the request Host is ignored', async (_name, origin) => {
    const response = await oauthLogin(auth, {
      credentials,
      secret: SECRET,
      ...origin,
    }).start.handle(new Request('https://attacker.test/auth/oauth/github'));
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get('location') ?? '');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://app.test/auth/oauth/github/callback',
    );
  });
});
