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
| brute force | per-IP, per-account and per-org buckets (`X_ACCOUNT_LOCKED`); every login failure is one indistinguishable `X_UNAUTHENTICATED`. `rateLimit: { scope: 'shared' }` makes the count one for the fleet. The org bucket (`orgMaxAttempts`, default 100 per window) can be exhausted by someone who knows about 20 of an org's addresses, locking its password sign-in — kept by decision ([`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md#known-gaps)) |

**Signing out** is `logout(auth, token)` for the row plus `signOutHeaders()` on the response: it
expires the session cookie and sends `Clear-Site-Data: "cache", "storage"`
(`SIGN_OUT_CLEAR_SITE_DATA`), so the browser drops the previous principal's IndexedDB, storage,
service worker and cached pages. Revocation at scale is `revokeUserSessions`, `revokeOrgSessions`,
`revokeSessionsCreatedBefore` (after rotating a secret) and `disableUser`, which also revokes the
user's live API keys. A `passwordHash` change through `updatePrivileges` ends every other session
of that user — all of them when no session of theirs is passed, as in a reset.

## OAuth

`github`, `google` and `apple` ship; `registerOAuthProvider` adds one. PKCE is mandatory on every
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
| `apple` | unproven: no sign-in has completed against it, and the callback is GET-only while Apple POSTs. **Removed from the built-ins in 26.0.0** (owner decision 14, [#709](https://github.com/developerz-ai/ultimate/issues/709)): an app that needs it registers its own with `registerOAuthProvider` |

## MFA, verification, API keys, workloads

| Capability | Calls |
|---|---|
| TOTP + recovery codes | `enrolTotp`, `saveTotpSecret`, `generateRecoveryCodes`. The secret is **sealed at rest** under the app's master key and a plaintext one is refused, never read (`X_MFA_SECRET_UNSEALED`; `x auth seal-mfa` seals rows from before); a recovery code is consumed in one statement, so it works once. A password proven with a factor outstanding is `X_MFA_REQUIRED`, whose `meta.challenge` is a sealed five-minute credential; `completeMfa(auth, challenge, code)` finishes the sign-in, meters the guess against the same lockout buckets a password guess spends, and refuses a spent code |
| email verification, password reset | `issueVerification` / `consumeVerification`; a token is consumed only when its hash matches, so a wrong guess cannot burn the victim's live link. The mail is sent through an injected `MailSender` ([Mail](Mail)) |
| API keys — how an agent authenticates | `issueApiKey` → `ult_<env>_<id>_<secret>`, shown once; `verifyApiKey` + `apiKeyActor` give a `kind: 'agent'` actor whose scopes are the key's and never the owner's roles (`X_API_KEY_INVALID`). A key is its owner's credential: a missing or disabled owner refuses it on the next use, a wildcard scope (`*`, `<resource>:*`) is refused at issue, and an owned key keeps only the scopes its owner's grants cover — pass `grantsOf` to expand roles ([`packages/auth/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/README.md)); a key with no `userId` is unchanged. `apiKeyResolver(() => store)` is both as the `resolveToken` a bearer mount and `defineAppMcp()` take: `{ actor, scopes }` for a live key, one `null` for every wrong one, and a store fault left a throw. In a test the store is `memoryAuthAdapter()` |
| service-to-service | `verifyWorkloadToken` reads a Kubernetes service-account token, a SPIFFE JWT-SVID or a cloud IMDS token (they are all one JWT); `actorFromService` gives a `kind: 'service'` actor. mTLS is the mesh's job |

Every auth code — `X_UNAUTHENTICATED`, `X_SESSION_EXPIRED`, `X_MFA_REQUIRED`, `X_OAUTH_*`,
`X_ACCOUNT_LOCKED`, `X_API_KEY_INVALID` and the rest — is in [Error codes](Error-Codes).
