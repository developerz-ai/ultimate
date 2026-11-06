// The fake provider against the REAL verifier: `discoverOAuthProvider` reads its document,
// `verifyIdToken` (`@ultimat3/auth`'s, with a real `jwksClient`) accepts its honest token, and each
// `tamper` is refused with the code a real provider's broken token gets. No socket opens.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  discoverOAuthProvider,
  jwksClient,
  oauthProfile,
  registerOAuthProvider,
  verifyIdToken,
} from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { fakeIdentityProvider } from './fake-identity-provider';
import { resetNetwork, sealNetwork } from './sealed-network';

sealNetwork();
afterEach(resetNetwork);

const clock = frozenClock('2026-11-06T09:00:00.000Z');
let serial = 0;

const setup = async () => {
  serial += 1;
  const issuer = `https://idp-${serial}.test`;
  const idp = await fakeIdentityProvider({
    issuer,
    clock,
    users: [{ sub: 'ada', email: 'ada@corp.test', name: 'Ada' }],
  });
  const provider = await discoverOAuthProvider({ id: `fake-${serial}`, issuer });
  registerOAuthProvider(provider);
  const verify = (idToken: string) =>
    verifyIdToken({
      provider: provider.id,
      idToken,
      clientId: idp.clientId,
      nonce: 'n-1',
      clock,
      keys: jwksClient({ provider: provider.id, jwksUri: idp.jwksUri, clock }),
    });
  return { idp, provider, verify };
};

const refusalCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return expect.unreachable('the token verified');
};

describe('fakeIdentityProvider', () => {
  test('its discovery document registers, and its token verifies', async () => {
    const { idp, provider, verify } = await setup();
    expect(provider.jwksUri).toBe(idp.jwksUri);
    const claims = await verify(await idp.idToken({ sub: 'ada', nonce: 'n-1' }));
    expect(claims).toMatchObject({ sub: 'ada', email: 'ada@corp.test', email_verified: true });
  });

  test('/authorize auto-approves as the chosen user, /token checks PKCE, /userinfo answers', async () => {
    const { idp } = await setup();
    const verifier = 'v'.repeat(64);
    const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${idp.issuer}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: idp.clientId,
      redirect_uri: 'https://app.test/cb',
      state: 's',
      nonce: 'n-1',
      code_challenge: challenge,
    }).toString();
    const redirect = await fetch(authorize, { redirect: 'manual' });
    const back = new URL(redirect.headers.get('location') ?? '');
    expect(back.searchParams.get('state')).toBe('s');
    const exchange = (code: string, codeVerifier: string) =>
      fetch(`${idp.issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, code_verifier: codeVerifier }).toString(),
      });
    const tokens = (await (
      await exchange(back.searchParams.get('code') ?? '', verifier)
    ).json()) as {
      access_token: string;
    };
    const info = await fetch(`${idp.issuer}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await info.json()).toMatchObject({ sub: 'ada', email_verified: true });
    // The code was spent; a second exchange is refused.
    expect((await exchange(back.searchParams.get('code') ?? '', verifier)).status).toBe(400);
  });

  test('each tamper is refused as a real broken token is', async () => {
    const { idp, verify } = await setup();
    for (const flag of ['wrongAudience', 'expired', 'wrongKey'] as const) {
      idp.tamper({ [flag]: true });
      const token = await idp.idToken({ sub: 'ada', nonce: 'n-1' });
      expect(await refusalCode(() => verify(token))).toBe('X_OAUTH_TOKEN_INVALID');
    }
    idp.tamper({});
    expect((await verify(await idp.idToken({ sub: 'ada', nonce: 'n-1' }))).sub).toBe('ada');
  });

  test('noEmailVerified leaves an address the profile reads as unverified', async () => {
    const { idp, provider, verify } = await setup();
    idp.tamper({ noEmailVerified: true });
    const idToken = await idp.idToken({ sub: 'ada', nonce: 'n-1' });
    const claims = await verify(idToken);
    expect(claims.email_verified).toBeUndefined();
    const profile = await oauthProfile(provider.id, {
      accessToken: 'unused',
      refreshToken: null,
      expiresAt: null,
      idToken,
      claims,
    });
    expect(profile.emailVerified).toBe(false);
  });
});
