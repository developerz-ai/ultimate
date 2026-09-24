# Auth

**The output of authentication is an `Actor`.** Nothing downstream authorizes on a session row, a
user row or an api key: HTTP, actions, jobs and MCP all read `ctx.actor` and hand it to the one
policy system ([Policies and authz](Policies-And-Authz)). Package `@ultimat3/auth` (tier 2) — the
full reference is
[`packages/auth/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/README.md);
the walk-through is [Tutorial 3](Tutorial-03-Auth-And-Admin).

```ts
import { BuiltinAdapter, defineAuth, login, oauthLogin } from '@ultimat3/auth';

export const auth = defineAuth({
  adapter: new BuiltinAdapter(),            // or MemoryAdapter
  session: { absoluteTtlMs: 30 * 864e5, idleTtlMs: 7 * 864e5 },
  password: { minLength: 12 },
  mfa: { issuer: 'Acme' },
  providers: ['github', 'google'],         // required to serve any OAuth route — the default is []
});

const { actor, token, cookie } = await login(auth, { email, password, ip });
const { start, callback } = oauthLogin(auth);   // /auth/oauth/:provider and its callback
```

The tables (`x_users`, `x_sessions`, `x_accounts`, `x_verifications`, `x_api_keys`) are created by
every boot; an app writes no migration for them.

## Sessions

| Property | How |
|---|---|
| opaque tokens | only `sha256(secret)` reaches the database |
| two expiries, independent | absolute and idle; activity never moves the absolute ceiling (`X_SESSION_EXPIRED` names which) |
| not a write per request | `lastSeenAt` moves at most once per `idleSlideMs` (default `idleTtlMs / 20`); a changed IP or user agent is written at once |
| revocation is immediate | the user row is re-read on every request, so a revoked role takes effect on the next one |
| the cookie | `__Host-x_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age` |
| brute force | per-IP, per-account and per-org buckets (`X_ACCOUNT_LOCKED`); every login failure is one indistinguishable `X_UNAUTHENTICATED`. `rateLimit: { scope: 'shared' }` makes the count one for the fleet |

**Signing out** is `logout(auth, token)` for the row plus `signOutHeaders()` on the response: it
expires the session cookie and sends `Clear-Site-Data: "cache", "storage"`
(`SIGN_OUT_CLEAR_SITE_DATA`), so the browser drops the previous principal's IndexedDB, storage,
service worker and cached pages. Revocation at scale is `revokeUserSessions`, `revokeOrgSessions`,
`revokeSessionsCreatedBefore` (after rotating a secret) and `disableUser`.

## OAuth

`github`, `google` and `apple` ship; `registerOAuthProvider` adds one. PKCE is mandatory on every
provider — `usesPkce: false` does not typecheck — and the handshake is a signed `__Host-` cookie
bound to its provider. An id token is verified against the provider's JWKS. An identity links to an
**existing** account only when both the provider and that account have verified the address
(`link: 'verified-email'`, the default); `'never'` is the only alternative. Credentials are
`<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`.

## MFA, verification, API keys, workloads

| Capability | Calls |
|---|---|
| TOTP + recovery codes | `enrolTotp`, `verifyTotp`, `createTotpReplayGuard`, `generateRecoveryCodes`, `redeemRecoveryCode` — pure functions; the secret and the hashes are the app's rows. A password proven with a factor outstanding is `X_MFA_REQUIRED` |
| email verification, password reset | `issueVerification` / `consumeVerification`; a token is consumed only when its hash matches, so a wrong guess cannot burn the victim's live link. The mail is sent through an injected `MailSender` ([Mail](Mail)) |
| API keys — how an agent authenticates | `issueApiKey` → `ult_<env>_<id>_<secret>`, shown once; `verifyApiKey` + `apiKeyActor` give a `kind: 'agent'` actor whose scopes are **exactly** the key's, never the owner's roles (`X_API_KEY_INVALID`) |
| service-to-service | `verifyWorkloadToken` reads a Kubernetes service-account token, a SPIFFE JWT-SVID or a cloud IMDS token (they are all one JWT); `actorFromService` gives a `kind: 'service'` actor. mTLS is the mesh's job |

Every auth code — `X_UNAUTHENTICATED`, `X_SESSION_EXPIRED`, `X_MFA_REQUIRED`, `X_OAUTH_*`,
`X_ACCOUNT_LOCKED`, `X_API_KEY_INVALID` and the rest — is in [Error codes](Error-Codes).
