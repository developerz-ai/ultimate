// The grant seam, through both entry points: what an SSO login writes onto the user's roles, org
// and scopes — on creation, on every login after it, and when the app has no opinion at all.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import { beginOAuth, type OAuthHandshake } from './oauth';
import type { OAuthFetch } from './oauth-exchange';
import { completeOAuthLogin, signInWithOAuth } from './oauth-login';
import { credentials, freshAuth, json, NOW, profile, tokens } from './oauth-login-fixture';

let adapter: MemoryAdapter;
let auth: Auth;

beforeEach(() => {
  ({ adapter, auth } = freshAuth());
});

/**
 * The failure case first: `alice@corp.com` signs in through SSO for the first time and the route
 * passes no roles and no org, so `createUserFor` writes `roles: []`, `orgId: null`. Her actor is
 * `userActor({ orgId: undefined, roles: [], scopes: [] })` — every `can()` denies her and every
 * read of a tenant-scoped entity throws before the query is built. SSO "works" and she can do
 * nothing until somebody runs SQL.
 */
const githubHandshake = (): OAuthHandshake =>
  beginOAuth({
    provider: 'github',
    clientId: 'client-id',
    redirectUri: 'https://app.test/auth/callback',
  });

const githubFetch = (): OAuthFetch => async (url) => {
  if (url === 'https://github.com/login/oauth/access_token') {
    return json({ access_token: 'gho_token', token_type: 'bearer' });
  }
  if (url === 'https://api.github.com/user') return json({ id: 583231, login: 'octocat' });
  if (url === 'https://api.github.com/user/emails') {
    return json([{ email: 'ada@example.com', primary: true, verified: true }]);
  }
  return expect.unreachable(`unexpected endpoint: ${url}`);
};

describe('the grant seam', () => {
  test('without it, a first-time SSO user gets an actor that can do nothing', async () => {
    const result = await signInWithOAuth(auth, { profile: profile(), tokens: tokens() });
    expect(result.actor.roles).toEqual([]);
    expect(result.actor.orgId).toBeUndefined();
    expect(result.actor.scopes).toEqual([]);
  });

  test('with it, a first-time SSO user gets exactly what the seam returned', async () => {
    const HANDSHAKE = githubHandshake();
    const result = await completeOAuthLogin(auth, {
      handshake: HANDSHAKE,
      callback: { state: HANDSHAKE.state, code: 'the-code' },
      credentials,
      fetch: githubFetch(),
      resolveGrants: (identity) => ({
        orgId: identity.email === 'ada@example.com' ? 'org-1' : null,
        roles: ['member'],
        scopes: ['tenancy:cross'],
      }),
    });
    expect(result.actor.orgId).toBe('org-1');
    expect(result.actor.roles).toEqual(['member']);
    expect(result.actor.scopes).toEqual(['tenancy:cross']);
  });

  test('it is authoritative on EVERY login, so a group removed in the IdP takes effect', async () => {
    const first = await signInWithOAuth(auth, {
      profile: profile(),
      tokens: tokens(),
      grants: { orgId: 'org-1', roles: ['admin', 'member'] },
    });
    expect(first.actor.roles).toEqual(['admin', 'member']);

    // Somebody removes her from the `admin` group in the IdP. Applying grants only at creation
    // made that a no-op forever, which is the half of A3 that reads as "revocation does nothing".
    const second = await signInWithOAuth(auth, {
      profile: profile(),
      tokens: tokens(),
      grants: { orgId: 'org-1', roles: ['member'] },
    });
    expect(second.actor.roles).toEqual(['member']);
    expect((await adapter.findUserById(second.actor.id))?.roles).toEqual(['member']);
  });

  test('a seam that returns the stored answer writes nothing', async () => {
    let writes = 0;
    class CountingAdapter extends MemoryAdapter {
      override async updateUser(
        id: string,
        patch: Parameters<MemoryAdapter['updateUser']>[1],
      ): Promise<AuthUser | null> {
        writes += 1;
        return await super.updateUser(id, patch);
      }
    }
    const counting = new CountingAdapter();
    const countingAuth = defineAuth({
      adapter: counting,
      clock: frozenClock(NOW),
      providers: ['github'],
    });
    const grants = { orgId: 'org-1', roles: ['member'] };
    // The create path stamps the verified address, which is the one write here.
    await signInWithOAuth(countingAuth, { profile: profile(), tokens: tokens(), grants });
    const afterFirst = writes;
    await signInWithOAuth(countingAuth, { profile: profile(), tokens: tokens(), grants });
    expect(writes).toBe(afterFirst);
  });

  test('an absent seam leaves an existing row exactly as it was', async () => {
    await signInWithOAuth(auth, {
      profile: profile(),
      tokens: tokens(),
      grants: { orgId: 'org-1', roles: ['admin'] },
    });
    const again = await signInWithOAuth(auth, { profile: profile(), tokens: tokens() });
    // No opinion means no rewrite — an app without a seam must not have its roles wiped.
    expect(again.actor.roles).toEqual(['admin']);
    expect(again.actor.orgId).toBe('org-1');
  });
});
