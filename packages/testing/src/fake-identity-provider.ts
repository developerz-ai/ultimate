// A fake OpenID provider, served through `mockFetch` with no socket: a discovery document, a JWKS
// from a key generated per instance, `/authorize` auto-approving as a chosen user, `/token` (PKCE
// checked) and `/userinfo`. `tamper()` mints the failures that matter — wrong audience, expired,
// wrong key, no `email_verified` — so a sign-in test proves the refusals, not just the happy path.

import type { Clock } from '@ultimat3/core';
import { assert, systemClock, timingSafeEqual } from '@ultimat3/core';
import { mockFetch } from './sealed-network';

export interface FakeIdpUser {
  readonly sub: string;
  readonly email: string;
  /** Defaults to `true`. `tamper({ noEmailVerified })` drops the claim entirely. */
  readonly emailVerified?: boolean | undefined;
  readonly name?: string | undefined;
}

export interface FakeIdpTamper {
  /** `aud` names another client. */
  readonly wrongAudience?: boolean | undefined;
  /** `exp` an hour ago. */
  readonly expired?: boolean | undefined;
  /** Signed by a key the JWKS does not publish, under the same `kid`. */
  readonly wrongKey?: boolean | undefined;
  /** No `email_verified` claim, in the id token or `/userinfo`. */
  readonly noEmailVerified?: boolean | undefined;
}

export interface FakeIdentityProviderInput {
  /** Defaults to `https://idp.test`. */
  readonly issuer?: string | undefined;
  readonly users: readonly FakeIdpUser[];
  readonly clock?: Clock | undefined;
  /** Defaults to `fake-client`. */
  readonly clientId?: string | undefined;
}

export interface FakeIdentityProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly jwksUri: string;
  /** Who `/authorize` approves as next. Defaults to the first user. */
  signInAs(sub: string): void;
  /** Applies to every token minted after it; `tamper({})` restores honesty. */
  tamper(flags: FakeIdpTamper): void;
  /** An id token minted directly, for a test that skips the redirect leg. */
  idToken(input: { readonly sub: string; readonly nonce?: string | undefined }): Promise<string>;
}

type KeyPair = CryptoKeyPair;
const KID = 'fake-idp-key';
const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const segment = (value: unknown): string => b64url(encoder.encode(JSON.stringify(value)));
const random = (bytes = 24): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const es256 = (): Promise<KeyPair> =>
  crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

interface PendingCode {
  readonly sub: string;
  readonly nonce: string | null;
  readonly challenge: string | null;
}

export async function fakeIdentityProvider(
  input: FakeIdentityProviderInput,
): Promise<FakeIdentityProvider> {
  assert(
    input.users.length > 0,
    'fakeIdentityProvider was given no users',
    'pass users: [{ sub, email }]',
  );
  const issuer = (input.issuer ?? 'https://idp.test').replace(/\/+$/, '');
  const clientId = input.clientId ?? 'fake-client';
  const clientSecret = random();
  const clock = input.clock ?? systemClock;
  const [published, rogue] = await Promise.all([es256(), es256()]);
  const jwk = await crypto.subtle.exportKey('jwk', published.publicKey);
  const users = new Map(input.users.map((user) => [user.sub, user]));
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, string>();
  let chosen = input.users[0]?.sub ?? '';
  let flags: FakeIdpTamper = {};

  const claimsOf = (user: FakeIdpUser) => ({
    email: user.email,
    ...(flags.noEmailVerified === true ? {} : { email_verified: user.emailVerified ?? true }),
    ...(user.name === undefined ? {} : { name: user.name }),
  });

  async function idToken(token: { sub: string; nonce?: string | undefined }): Promise<string> {
    const user = users.get(token.sub);
    assert(user !== undefined, `fake IdP has no user ${token.sub}`, 'add it to users: [...]');
    const now = Math.floor(clock.now().getTime() / 1000);
    const body = `${segment({ alg: 'ES256', kid: KID, typ: 'JWT' })}.${segment({
      iss: issuer,
      sub: user.sub,
      aud: flags.wrongAudience === true ? 'another-client' : clientId,
      iat: now,
      exp: flags.expired === true ? now - 3600 : now + 3600,
      ...(token.nonce === undefined ? {} : { nonce: token.nonce }),
      ...claimsOf(user),
    })}`;
    const key = (flags.wrongKey === true ? rogue : published).privateKey;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      encoder.encode(body),
    );
    return `${body}.${b64url(new Uint8Array(signature))}`;
  }

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  mockFetch(`GET ${issuer}/.well-known/openid-configuration`, () =>
    json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      code_challenge_methods_supported: ['S256'],
    }),
  );
  mockFetch(`GET ${issuer}/jwks`, () =>
    json({ keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] }),
  );
  mockFetch(`GET ${issuer}/authorize*`, (request) => {
    const params = new URL(request.url).searchParams;
    const redirect = params.get('redirect_uri');
    if (redirect === null || params.get('client_id') !== clientId) {
      return json({ error: 'invalid_request' }, 400);
    }
    const code = random();
    codes.set(code, {
      sub: chosen,
      nonce: params.get('nonce'),
      challenge: params.get('code_challenge'),
    });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    const state = params.get('state');
    if (state !== null) back.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  });
  mockFetch(`POST ${issuer}/token`, async (request) => {
    const form = new URLSearchParams(await request.text());
    const pending = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    if (pending === undefined) return json({ error: 'invalid_grant' }, 400);
    const verifier = form.get('code_verifier') ?? '';
    const digest = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
    if (pending.challenge !== null && !timingSafeEqual(digest, pending.challenge)) {
      return json({ error: 'invalid_grant' }, 400);
    }
    const access = random();
    accessTokens.set(access, pending.sub);
    return json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
      id_token: await idToken({ sub: pending.sub, nonce: pending.nonce ?? undefined }),
    });
  });
  mockFetch(`GET ${issuer}/userinfo`, (request) => {
    const access = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    const user = users.get(accessTokens.get(access) ?? '');
    if (user === undefined) return json({ error: 'invalid_token' }, 401);
    return json({ sub: user.sub, ...claimsOf(user) });
  });

  return {
    issuer,
    clientId,
    clientSecret,
    jwksUri: `${issuer}/jwks`,
    signInAs(sub) {
      assert(users.has(sub), `fake IdP has no user ${sub}`, 'add it to users: [...]');
      chosen = sub;
    },
    tamper(next) {
      flags = { ...next };
    },
    idToken,
  };
}
