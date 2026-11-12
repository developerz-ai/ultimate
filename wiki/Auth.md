# Auth

**The output of authentication is an `Actor`.** Nothing downstream authorizes on a session row, a
user row or an api key: HTTP, actions, jobs and MCP all read `ctx.actor` and hand it to the one
policy system ([Policies and authz](Policies-And-Authz)). Package `@ultimat3/auth` (tier 2) — the
full reference is
[`packages/auth/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/README.md);
the walk-through is [Tutorial 3](Tutorial-03-Auth-And-Admin).

```ts
import { defineAuth, login, oauthLogin, postgresAuthAdapter } from '@ultimat3/auth';

export const auth = defineAuth({
  adapter: postgresAuthAdapter(),            // or memoryAuthAdapter()
  session: { absoluteTtlMs: 30 * 864e5, idleTtlMs: 7 * 864e5 },
  password: { minLength: 12 },
  mfa: { issuer: 'Acme' },
  providers: ['github', 'google'],         // required to serve any OAuth route — the default is []
});

const { actor, token, cookie } = await login(auth, { email, password, ip });
const { start, callback } = oauthLogin(auth);   // /auth/sso/:provider and its callback
```

The tables (`x_users`, `x_sessions`, `x_accounts`, `x_verifications`, `x_api_keys`, and the
passkeys' `x_passkeys`, `x_passkey_challenges`, `x_passkey_evidence`) are created by every boot; an
app writes no migration for them.

**Signing in by handle** (`As of 2026-10`): an app whose users are `@ada` names the lookup once —
`defineAuth({ adapter, handles: async (handle) => (await db.users.where({ handle }).one())?.id ?? null })`
— and calls `login(auth, { handle, password })`. The handle arrives trimmed and lowercased
(`normaliseHandle`), its failures count against a bucket of its own, and an unknown handle is the
same `X_UNAUTHENTICATED` after the same hash as a wrong password. The app's `users` row and the auth
user share one id: `register(auth, { id, email, password })` creates the auth user under it. A handle
login on an app that declared no `handles` is `X_CONFIG_INVALID`. The deployed demo
(`dummy/social-media-clone/apps/web/app/auth/`) signs in this way.

## Sessions

| Property | How |
|---|---|
| opaque tokens | only `sha256(secret)` reaches the database |
| two expiries, independent | absolute and idle; activity never moves the absolute ceiling (`X_SESSION_EXPIRED` names which) |
| not a write per request | `lastSeenAt` moves at most once per `idleSlideMs` (default `idleTtlMs / 20`); a changed IP or user agent is written at once |
| revocation is immediate | the user row is re-read on every request, so a revoked role takes effect on the next one |
| the cookie | `__Host-x_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age` |
| brute force | per-IP, per-account and per-org buckets (`X_ACCOUNT_LOCKED`); every login failure is one indistinguishable `X_UNAUTHENTICATED`. `rateLimit: { scope: 'shared' }` makes the count one for the fleet. The org bucket (`orgMaxAttempts`, default 100 per window) can be exhausted by someone who knows about 20 of an org's addresses, locking its password sign-in — kept by decision ([`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md#known-gaps)) |

**Signing out** is `logout(auth, token)` for the row plus `signOutHeaders()` on the response: it
expires the session cookie and sends `Clear-Site-Data: "cache", "storage"`
(`SIGN_OUT_CLEAR_SITE_DATA`), so the browser drops the previous principal's IndexedDB, storage,
service worker and cached pages. Revocation at scale is `revokeUserSessions`, `revokeOrgSessions`,
`revokeSessionsCreatedBefore` (after rotating a secret) and `disableUser`, which also revokes the
user's live API keys. A `passwordHash` change through `updatePrivileges` ends every other session
of that user — all of them when no session of theirs is passed, as in a reset.

**A sign-in page is one command**, `As of 2026-11`: `x g sign-in --password` (a native form over
`login()`, its second leg over `completeMfa()`) or `x g sign-in --oidc <provider>` (an OpenID Connect
issuer, discovered on the first sign-in). Both write the sign-in page, the `destroySession` action,
`auth.signInPath`, and a boot guard: outside `development` and `test` a `web` or `sync` role with
its sign-in keys unset refuses to start (`X_AUTH_SIGN_IN_UNCONFIGURED`). `--password` also writes
`createSession` / `confirmSession` and the second-factor page; `--oidc` writes the start and
callback routes and drops `x new`'s development viewer while its files are still `x new`'s own. What each writes:
[CLI reference](CLI-Reference#x-g).

## OAuth

`github` and `google` ship; `registerOAuthProvider` adds one. PKCE is mandatory on every
provider — `usesPkce: false` does not typecheck — and the handshake is a signed `__Host-` cookie
bound to its provider. An id token is verified against the provider's JWKS. An identity links to an
**existing** account only when both the provider and that account have verified the address
(`link: 'verified-email'`, the default); `'never'` is the only alternative. Credentials are
`<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`.

| Rule (`As of 2026-10`) | |
|---|---|
| `redirect_uri` origin | `oauthLogin(auth, { baseUrl })`, else `APP_URL`. With neither the start leg answers `X_ENV_MISSING` — never the request's `Host` |
| a refused leg's body | `code`, `title`, `docs`, one fixed `cause`, `fix: x errors explain <CODE> --json`. The authored cause and fix are the `auth.oauth.refused` log line |
| `discoverOAuthProvider` | refuses a document whose `issuer` is not the one asked for (a trailing slash aside) |
| a public client (`As of 2026-10-18`) | `tokenEndpointAuth: 'none'` on the provider, `discoverOAuthProvider` or `credentials`: no `<PROVIDER>_CLIENT_SECRET` is read and no `client_secret` is sent; PKCE still is. `'client_secret_basic'` sends the pair in `Authorization: Basic`. Absent: `'client_secret_post'`, unchanged |
| `apple` | not a built-in since 26.0.0 ([#709](https://github.com/developerz-ai/ultimate/issues/709)): Apple POSTs its callback and both callback routes are GET, so it could never complete a sign-in. An app that needs it registers its own with `registerOAuthProvider` |

## SSO: OIDC and SAML behind one `IdentityProvider` port

Rule: every federated sign-in is an `IdentityProvider` (`@ultimat3/auth`), and `signInWithIdentity(auth, identity)` is the one path from it to a session — the same account-link, MFA and grant rules as [OAuth](#oauth). `As of 2026-11-09`.

| Member | Shape |
|---|---|
| `begin({ callbackUrl, clock })` | `{ location, state }` |
| `answers(state, params)` | whether `params` answer THIS browser's state — RelayState for SAML, `state` for OIDC — in constant time, nothing verified beyond it. The routes clear the state cookie only on an answer bound to it, so a junk cross-site form cannot end a sign-in in flight |
| `complete({ state, params, callbackUrl, clock, replay })` | `{ profile, expiresAt, claims }` |
| adapters | `samlIdentityProvider(config)`, `oidcIdentityProvider({ provider })` |
| your own | `behavesLike(identityProviderConformance, () => harness)` from `@ultimat3/testing/conformance` |

`identityProviderRoutes(auth, { providers })` mounts both kinds:

| Route | Method | Purpose |
|---|---|---|
| `/auth/sso/:provider` | GET | `begin`, seal the state in `__Host-x_sso_<id>`, 302 to the IdP |
| `/auth/sso/:provider/callback` | POST | the SAML ACS — register this URL at the IdP. The state cookie is `SameSite=None`: the IdP posts cross-site |
| `/auth/sso/:provider/callback` | GET | the OIDC `redirect_uri` |

```ts
import type { Auth } from '@ultimat3/auth';
import {
  identityProviderRoutes,
  oidcIdentityProvider,
  parseSamlMetadata,
  samlIdentityProvider,
} from '@ultimat3/auth';

declare const auth: Auth;
declare const corpMetadataXml: string; // the IdP's metadata document, read at boot

export const sso = identityProviderRoutes(auth, {
  providers: [
    samlIdentityProvider({
      id: 'corp',
      idp: parseSamlMetadata(corpMetadataXml),
      spEntityId: 'https://app.example/saml/metadata',
      trustEmail: true,
      emailDomains: ['corp.example'], // the exact domains this IdP owns
    }),
    oidcIdentityProvider({ provider: 'github' }),
  ],
  successPath: '/app',
});
```

`defineAuth({ providers })` lists both ids; an unknown or not-enabled id is `X_IDENTITY_PROVIDER_UNKNOWN` (404).

**OIDC replay.** `oidcIdentityProvider` claims the handshake's `state` once in the shared replay store before it spends the code, keyed on when the handshake was issued: a callback lifted from a browser is `X_OAUTH_STATE_INVALID` even inside the cookie's lifetime, and so is any answer more than 10 minutes after `begin` (`DEFAULT_HANDSHAKE_TTL_MS`).

Mount each leg with its `meta` verbatim — `{ method: leg.method, path: leg.path, handler: (request) => leg.handle(request.raw), meta: leg.meta }`. The ACS (POST) declares `csrf: 'cookieless'` and `authenticate: () => null`: the IdP answers with an auto-submitted cross-site form, which the csrf stage refuses on any other route (`403 X_CSRF_BLOCKED`). CSRF is held there by the protocol instead — the answer must carry this browser's RelayState, checked against the HMAC-sealed state cookie, and its assertion must answer this request's ID.

**SAML scope.** SP-initiated only: an AuthnRequest over HTTP-Redirect with RelayState, the response over HTTP-POST. Signed assertions are required; encrypted assertions, SHA-1 and RSA under 2,048 bits are refused; `trustEmail` is required, because SAML has no `email_verified`, and `trustEmail: true` requires `emailDomains` — an IdP's admin can assert any address, so only an address in a listed domain (exact; list each subdomain) is verified, and one outside it can neither link to an existing account nor create one (`trustEmail: true` with no domains is a type error and `X_CONFIG_INVALID` at construction); clock skew is ±60 s (`skewMs`). `parseSamlMetadata(xml)` → `{ entityId, ssoUrl, certificates }`, refused as `X_SAML_METADATA_INVALID` with no HTTP-Redirect SSO, no signing certificate, or an RSA key under 2,048 bits. Verification is in-package, no dependency ([build vs wrap](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/18-build-vs-wrap.md)). Every refusal is `X_SAML_RESPONSE_INVALID` with `meta.check`:

| Check | `meta.check` |
|---|---|
| a DOCTYPE, an entity, a processing instruction, over 512 KiB, more than 64 namespace declarations, one attribute twice | `xml` |
| more than one Assertion, one not a direct child, a `ds:Object` in a Signature | `structure` |
| one ID on two elements | `id-duplicate` |
| an EncryptedAssertion or EncryptedID | `encrypted` |
| the assertion unsigned (a signed response alone is refused) | `signature-missing` |
| not RSA-SHA256 / SHA-256 / exc-c14n + enveloped | `algorithm` |
| the Reference URI is not the assertion's own ID | `reference` |
| no metadata certificate verifies (KeyInfo is never read) | `signature` |
| content altered | `digest` |
| Status is not Success | `status` |
| Issuer is not the metadata's entityID | `issuer` |
| Destination / Recipient is not the ACS URL | `destination` / `recipient` |
| InResponseTo is not our AuthnRequest's ID | `in-response-to` |
| Audience is not `spEntityId` | `audience` |
| NotBefore / NotOnOrAfter | `not-before` / `expired` |
| a transient or empty NameID | `subject` |
| RelayState is not the browser's | `relay-state` |
| an assertion already consumed (`auth.totpReplay`, shared) | `replay` |

## Passkeys

**WebAuthn, verified by hand on WebCrypto — no dependency** (`As of 2026-11`). Two uses, one
declaration: `defineAuth({ passkeys: { rpId, origins } })`. ES256 and RS256; CBOR, COSE and DER are
parsed in this package, every malformed byte a refusal.

```ts
import { canonicalJson } from '@ultimat3/core';
import {
  defineAuth,
  memoryAuthAdapter,
  passkeyLogin,
  passkeyStepUp,
  sha256Hex,
  verifyPasskeyEvidence,
} from '@ultimat3/auth';

const auth = defineAuth({
  adapter: memoryAuthAdapter(),
  passkeys: { rpId: 'example.com', origins: ['https://example.com'] },
});

// Sign-in: register onto a signed-in account, then usernameless sign-in to the same session login() mints.
const { registerOptions, register, loginOptions, login } = passkeyLogin(auth);

// Step-up: the proof is bound to bytes the SERVER derives from the input, and stored as evidence.
const stepUp = passkeyStepUp<{ readonly to: string; readonly minor: number }>(auth, {
  ttlMs: 60_000,
  digest: ({ input }) => sha256Hex(canonicalJson(input)),
});

declare const userId: string;
declare const response: unknown;
const evidence = await stepUp.verify({ userId, input: { to: 'acct-7', minor: 12_500 }, response });
// Later, in another process, with the row alone:
const approved = await verifyPasskeyEvidence(evidence, { rpId: 'example.com', origins: ['https://example.com'] });
```

| Rule | |
|---|---|
| tier | functions over `Auth`, wrapped by the app's own actions (tier 2 constructs no `action`) — like `login` and `completeMfa` |
| browser | `@ultimat3/auth/client`: `newPasskey(options)` / `getPasskey(options)` answer `{ status: 'ok', response }`, `'cancelled'`, `'unsupported'` or `'failed'` — never a throw. Its graph is two files, ~2.3 kB minified (`client-bundle.test.ts`); an island never loads the server barrel |
| checked, every ceremony | `clientDataJSON` type, the origin against the declared list exactly (no cross-origin iframe), `rpIdHash`, **UP and UV** (user verification is required, never preferred), the signature with the STORED key's algorithm |
| challenge | 32 random bytes, stored as its sha256 in `x_passkey_challenges` with a TTL, consumed by one `DELETE … RETURNING` — single-use across the fleet, never a process map. Unknown, spent and late are one code: `X_PASSKEY_CHALLENGE_EXPIRED` |
| counter | a signature counter that did not move forward is a cloned authenticator (`X_PASSKEY_INVALID`); both zero is an authenticator that keeps none, allowed. Advanced compare-and-set |
| registration | `attestation: 'none'` — the statement is parsed, not trusted; a credential id already registered to anyone is `X_AUTH_WRITE_FAILED`; a challenge issued to one account never registers onto another |
| sign-in | the session is `mfaSatisfied`: a user-verified passkey is possession plus the device's PIN or biometric |
| step-up challenge | `SHA-256("ultimate.passkey.step-up.v1\0" ‖ nonce ‖ len ‖ digest ‖ userId)` — never supplied by a caller. A proof for other bytes, or none, is `X_PASSKEY_STEP_UP_REQUIRED` |
| evidence | `x_passkey_evidence`: the signed bytes, the nonce, the digest and the key itself, so `verifyPasskeyEvidence` re-checks it with no adapter and no clock; any edit to digest, nonce, user, key or signed bytes is `false`. `auth.adapter.listPasskeyEvidence(digest)` finds the approvals of one digest |
| refusals | `X_PASSKEY_INVALID` (which check failed is the `auth.passkey.refused` log line, never the cause), `X_PASSKEY_CHALLENGE_EXPIRED`, `X_PASSKEY_STEP_UP_REQUIRED`; a bad `passkeys` block is `X_CONFIG_INVALID` at `defineAuth` |

## MFA, verification, API keys, workloads

| Capability | Calls |
|---|---|
| TOTP + recovery codes | `enrolTotp`, `saveTotpSecret`, `generateRecoveryCodes`. The secret is **sealed at rest** under the app's master key and a plaintext one is refused, never read (`X_MFA_SECRET_UNSEALED`; `x auth seal-mfa` seals rows from before); a recovery code is consumed in one statement, so it works once. A password proven with a factor outstanding is `X_MFA_REQUIRED`, whose `meta.challenge` is a sealed five-minute credential; `completeMfa(auth, challenge, code)` finishes the sign-in, meters the guess against the same lockout buckets a password guess spends, and refuses a spent code on every replica (`x_totp_steps`, installed by the boot) |
| email verification, password reset, any other mailed credential | `defineVerificationPurpose({ name, template, ttlMs, identifier? })` → `{ issue, consume }` (`As of 2026-11`); `emailVerification` and `passwordReset` are its two built-in instances, and `issueVerification` / `consumeVerification` take any declared name. A token is consumed only when its hash matches, so a wrong guess cannot burn the victim's live link, and one purpose's token never consumes another's. A name declared twice or with no template is `X_VERIFICATION_PURPOSE_INVALID` at boot; an undeclared one at the call is `X_VERIFICATION_PURPOSE_UNKNOWN` (400). `VerificationPurpose` is `string`: a `switch` over it needs a default arm. The mail is sent through an injected `MailSender` ([Mail](Mail)) |
| API keys — how an agent authenticates | `issueApiKey` → `ult_<env>_<id>_<secret>`, shown once; `verifyApiKey` + `apiKeyActor` give a `kind: 'agent'` actor whose scopes are the key's and never the owner's roles (`X_API_KEY_INVALID`). A key is its owner's credential: a missing or disabled owner refuses it on the next use, a wildcard scope (`*`, `<resource>:*`) is refused at issue, and an owned key keeps only the scopes its owner's grants cover — pass `grantsOf` to expand roles ([`packages/auth/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/README.md)); a key with no `userId` is unchanged. `apiKeyResolver(() => store)` is both as the `resolveToken` a bearer mount and `defineAppMcp()` take: `{ actor, scopes }` for a live key, one `null` for every wrong one, and a store fault left a throw. In a test the store is `memoryAuthAdapter()` |
| service-to-service | `verifyWorkloadToken` reads a Kubernetes service-account token, a SPIFFE JWT-SVID or a cloud IMDS token (they are all one JWT); `actorFromService` gives a `kind: 'service'` actor. The returned `WorkloadToken` carries `raw`, the whole decoded payload, read only after every check held. mTLS is the mesh's job |
| an external issuer's bearer (`As of 2026-11`) | `jwtBearerResolver({ keys, issuers, audience, requiredScope?, accept?, actorOf })` — `apiKeyResolver`'s twin for JWTs, the `resolveToken` a bearer mount and `defineAppMcp()` take. `keys` is a thunk read when a token arrives (no discovery at import); `accept(raw)` is the app's own claim check after the signature; `actorOf(token)` builds the actor. Every refusal — signature, issuer, audience, expiry, scope, `accept`, and a key set that cannot be read — is `null` plus one `auth.jwt_bearer.refused` log line naming the check, never a claim's value. The mount answers that `null` as `401 X_UNAUTHENTICATED` |

## Authorization server

`As of 2026-11`. `authorizationServer({ issuer, store, consentPath, lifetimes, scopes, registration?, grants?, resources? })`
is one OAuth 2.1 server for an app's MCP endpoint, public API, CLI and partners alike. It ships the
RFC rules; the consent page, who may be a client and what a subject becomes are the app's.

```ts
import type { Actor, PgExecutor } from '@ultimat3/core';
import { authorizationServer, oauthBearerResolver, postgresAuthServerStore } from '@ultimat3/auth';

declare const executor: PgExecutor;
declare function actorFor(subject: string): Promise<Actor | null>;

export const oauth = authorizationServer({
  issuer: 'https://www.example.com',
  store: postgresAuthServerStore({ executor }),
  consentPath: '/oauth/consent',               // the app's page; the advertised authorization_endpoint
  lifetimes: { accessSeconds: 600, refreshIdleDays: 30, clientSeconds: 900 },
  scopes: ['cases:read', 'cases:write'],
  grants: ['authorization_code', 'refresh_token', 'client_credentials'],
});
export const runtime = { routes: [...oauth.routes] };           // apps/web/runtime.ts
const resolveToken = oauthBearerResolver(oauth, { actor: (grant) => actorFor(grant.subject) });
```

| Piece | What it does |
|---|---|
| `routes` | `GET /.well-known/oauth-authorization-server` (RFC 8414), `POST /oauth/token`, `/oauth/revoke` (RFC 7009), `/oauth/introspect` (RFC 7662), plus `/oauth/register` (RFC 7591, `registration: 'dynamic'`) and `/oauth/device` (RFC 8628). Plain `Route`s for `runtime.routes`, public, no cookie authenticates them. Every answer is `no-store` RFC 6749 JSON |
| consent | the page calls `readRequest(url)` → `{ client, scopes, resource, redirectUri }` or a refusal; an unknown client or unregistered redirect has `redirectTo: null` — render it, never redirect. Its action calls `approve({ subject, request, scopes? })` / `deny({ request })` for the redirect URL (`code`, `state`, `iss`). A forged request is `X_AUTH_CONSENT_INVALID` (422) |
| device | the verification page calls `readDevice({ userCode, key })`, `approveDevice` / `denyDevice`; `key` is the caller's bucket — 10 misses lock it (`X_ACCOUNT_LOCKED`) |
| `registerClient(...)` | a client the app creates itself — a partner's `client_credentials` client; the secret is shown once and stored hashed |
| `resolve(token)` | `{ subject, scopes, clientId, resource } \| null`. `oauthBearerResolver(server, { actor, resource? })` is the `resolveToken` a bearer mount and `defineAppMcp` take; `actor` runs per call, so a removed member loses access at once |
| `revoke({ subject, clientId? })` · `purge({ before })` | immediate; `purge` is the app's `task` to schedule, nothing here runs on a timer |

| Rule | Held by |
|---|---|
| redirect URIs match byte for byte | `authorization-server-request.test.ts` |
| S256 only; an absent method is `plain` and refused | same |
| a code lives 2 minutes, is stored hashed, is single use; a replay revokes what it minted | `authorization-server.test.ts`, `authServerStoreConformance` from `@ultimat3/testing/conformance` (racing redemptions, run on memory and on Postgres by `auth-server-store-conformance-postgres.live.test.ts`) |
| refresh rotates; a retired one's replay revokes the grant; idle past `refreshIdleDays` is dead | `authorization-server.test.ts` |
| refresh tokens only for a client whose `grantTypes` list `refresh_token`; otherwise none is issued and refreshing is `unauthorized_client` (device grant too) | `authorization-server.test.ts`, `authorization-server-postgres.test.ts` |
| a confidential client authenticates only with its registered `token_endpoint_auth_method`; the other is `invalid_client` | `authorization-server-clients.test.ts` |
| a redirect URI containing whitespace is refused at registration | `authorization-server-clients.test.ts` |
| `resource` (RFC 8707) binds the grant; one not in `resources` is `invalid_target` | `authorization-server-request.test.ts`, `oauth-bearer-resolver.test.ts` |
| tokens are opaque and stored hashed, never a JWT, so `revoke` holds on the next lookup | `token-endpoints.test.ts` |
| an `https://` `client_id` is a metadata document, fetched through `outbound({ dial: 'public' })`, 5 KiB, cached 5 minutes, public clients only | `authorization-server-clients.test.ts` |
| `client_credentials`: confidential only, no refresh token, subject is the client | `grant-client-credentials.test.ts` |
| dynamic registration never hands out `client_credentials` and is counted per address | `authorization-server-clients.test.ts` |

Bad configuration is `X_AUTH_SERVER_INVALID` naming the field; a grant not in `grants` answers
`unsupported_grant_type` and is logged `X_AUTH_GRANT_DISABLED`. The five tables (`x_oauth_*`) are
applied by the boot. For one MCP endpoint, `mcpAuthorizationServer` ([MCP and AI](MCP-And-AI)).

Every auth code — `X_UNAUTHENTICATED`, `X_SESSION_EXPIRED`, `X_MFA_REQUIRED`, `X_OAUTH_*`,
`X_ACCOUNT_LOCKED`, `X_API_KEY_INVALID` and the rest — is in [Error codes](Error-Codes).
