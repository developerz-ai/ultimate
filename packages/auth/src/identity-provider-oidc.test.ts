// The OIDC adapter's single-use claim, across time: a callback replayed later inside the state's
// ten-minute life must still meet its first claim. The claim's step is fixed by when the handshake
// was ISSUED, never by when a completion arrives — or each 30 s step is a fresh row.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { oidcIdentityProvider } from './identity-provider-oidc';
import { memoryTotpReplayGuard } from './mfa';
import { DEFAULT_HANDSHAKE_TTL_MS } from './oauth-cookie';
import type { OAuthFetch } from './oauth-exchange';
import { credentials, json } from './oauth-login-fixture';

const CALLBACK = 'https://app.example.test/auth/sso/github/callback';

const githubFetch: OAuthFetch = async (url) => {
  if (url.endsWith('/access_token')) return json({ access_token: 'gho_x', token_type: 'bearer' });
  if (url.endsWith('/user')) return json({ id: 583231, login: 'octocat' });
  return json([{ email: 'octo@example.com', primary: true, verified: true }]);
};

const outcome = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'accepted',
    (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
  );

describe('oidcIdentityProvider: a completed handshake stays completed', () => {
  for (const laterMs of [61_000, 5 * 60_000, DEFAULT_HANDSHAKE_TTL_MS - 1_000]) {
    test(`a callback replayed ${laterMs / 1000} s later is refused`, async () => {
      const clock = frozenClock('2026-11-09T12:00:00.000Z');
      const replay = memoryTotpReplayGuard();
      const provider = oidcIdentityProvider({
        provider: 'github',
        credentials,
        fetch: githubFetch,
      });
      const redirect = await provider.begin({ callbackUrl: CALLBACK, clock });
      const state = new URL(redirect.location).searchParams.get('state') ?? '';
      const complete = () =>
        provider.complete({
          state: redirect.state,
          params: { state, code: 'c0de' },
          callbackUrl: CALLBACK,
          clock,
          replay,
        });
      expect(await outcome(complete())).toBe('accepted');
      clock.advance(laterMs);
      expect(await outcome(complete())).toBe('X_OAUTH_STATE_INVALID');
    });
  }

  test('a handshake past its ten minutes is refused before anything is claimed', async () => {
    const clock = frozenClock('2026-11-09T12:00:00.000Z');
    const provider = oidcIdentityProvider({ provider: 'github', credentials, fetch: githubFetch });
    const redirect = await provider.begin({ callbackUrl: CALLBACK, clock });
    const state = new URL(redirect.location).searchParams.get('state') ?? '';
    clock.advance(DEFAULT_HANDSHAKE_TTL_MS + 1);
    const call = provider.complete({
      state: redirect.state,
      params: { state, code: 'c0de' },
      callbackUrl: CALLBACK,
      clock,
      replay: memoryTotpReplayGuard(),
    });
    expect(await outcome(call)).toBe('X_OAUTH_STATE_INVALID');
  });
});
