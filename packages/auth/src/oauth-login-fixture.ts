// The fixtures the three `oauth-login` suites share: the frozen instant, a fresh
// `MemoryAdapter`-backed `Auth`, the two request bodies, the code of a rejection and a JSON
// `Response`. Shared rather than copied — three suites building their own `Auth` would be three
// flows that agree only by construction, the same reason `backfill-pass-fixture.ts` exists.

import { frozenClock, isUltimateError } from '@ultimat3/core';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import type { OAuthTokens } from './oauth-exchange';
import type { OAuthProfile } from './oauth-profile';

export const NOW = new Date('2026-08-09T12:00:00.000Z');

export const credentials = { clientId: 'client-id', clientSecret: 'client-secret' };

/** One adapter and the `Auth` over it, minted per `beforeEach` — never shared between tests. */
export const freshAuth = (): { adapter: MemoryAdapter; auth: Auth } => {
  const adapter = new MemoryAdapter();
  return {
    adapter,
    auth: defineAuth({ adapter, clock: frozenClock(NOW), providers: ['github', 'google'] }),
  };
};

export const profile = (overrides: Partial<OAuthProfile> = {}): OAuthProfile => ({
  provider: 'github',
  providerAccountId: '583231',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada Lovelace',
  ...overrides,
});

export const tokens = (overrides: Partial<OAuthTokens> = {}): OAuthTokens => ({
  accessToken: 'gho_first',
  refreshToken: null,
  expiresAt: null,
  idToken: null,
  claims: null,
  ...overrides,
});

export const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

export const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
