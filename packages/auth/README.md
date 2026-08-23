# @ultimat3/auth 🔐

**The output of authentication is an `Actor` from `@ultimat3/core`.** Nothing downstream
authorizes on a session row, a user row or an api key — http, actions, jobs and MCP all read
`ctx.actor` and hand it to `@ultimat3/policy`. One authz system, never two.

```ts
import { BuiltinAdapter, defineAuth, login, oauthLogin } from '@ultimat3/auth';

export const auth = defineAuth({
  adapter: new BuiltinAdapter(),          // or MemoryAdapter, or your Better Auth binding
  session: { absoluteTtlMs: 30 * 864e5, idleTtlMs: 7 * 864e5 },
  password: { minLength: 12 },
  mfa: { issuer: 'Acme' },                // the authenticator app's name; `required` only as `false`
  providers: ['github', 'google'],       // REQUIRED to serve any OAuth route — the default is []
  link: 'verified-email',                 // the default; `'never'` is the only other value
});

const { actor, token, cookie } = await login(auth, { email, password, ip });

// "Log in with GitHub" is a link to /auth/oauth/github. These two routes are what serves it.
const { start, callback } = oauthLogin(auth);
```

## Rules

- Every login failure throws `loginFailed()` from `rate-limit.ts`. Never a specific message.
- Session ids are opaque random tokens; only `sha256(secret)` reaches the database.
- Absolute and idle expiry are evaluated **independently**. Activity never moves the ceiling.
- PKCE is mandatory on every provider — `OAuthProvider.usesPkce` is the literal `true`, so
  `usesPkce: false` does not typecheck and there is no branch that skips the verifier.
- Recovery codes, verification tokens and api keys are hashed at rest and single-use.
- A verification token is consumed **only when its hash matches**, in the same statement — the
  store takes `(purpose, identifier, tokenHash)`. Consuming first and comparing afterwards made an
  unauthenticated wrong guess destroy the victim's live reset link.
- Guards assert on the actor. They never evaluate a policy.
- A user's `scopes` column reaches `Actor.scopes`, so a human can hold a scope. `permissions` is a
  different field and `hasScope()` does not read it.
- `verifySession` writes at most once per `idleSlideMs`, not once per request.
- The lockout counts attempts against one identity, so it has to be **one** count. `AuthLimiter`
  is async on every member and declares the policy it enforces; `defineAuth` refuses a limiter
  that disagrees with the app's declaration.

## The lockout across replicas

`createAuthLimiter` keeps its table in the process, so `maxAttempts: 5` at `replicas: 3` lets an
account survive 15 guesses and hides each replica's lockout from the other two. An app that runs
more than one process says so and brings a limiter that says the same:

```ts
defineAuth({
  adapter,
  rateLimit: { maxAttempts: 5, scope: 'shared' },  // the whole fleet's allowance
  limiter: myLimiter,                              // whose policy says exactly the same
});
```

`Auth.rateLimit` is what an operator reads as "what this deployment enforces", so `defineAuth`
refuses any pairing that would make it a lie:

| Declared | Limiter's own `policy` | Result |
|---|---|---|
| `scope: 'process'` (default) | anything, same numbers | boots; the lockout is per replica |
| `scope: 'shared'` | `scope: 'shared'`, same numbers | boots; one count for the fleet |
| `scope: 'shared'` | `scope: 'process'` | `X_AUTH_LIMITER_NOT_SHARED` |
| `maxAttempts`/`windowMs`/`lockoutMs` | any of the three different | `X_AUTH_LIMITER_POLICY_MISMATCH` |

### The third bucket: one tenant

`account:<email>` and `ip:<addr>` were the only key shapes, so one tenant's misconfigured
integration hammering login from 400 addresses was capped by neither — each IP bucket allowed its
own quota, the account buckets protected individuals, and the shared limiter saturated behind
them. `orgKey(orgId)` is the third shape, checked in `login()` once the address resolves to an org
and still before the KDF runs.

`rateLimit.orgMaxAttempts` is its own number, defaulting to `maxAttempts * 20`: a whole tenant
sharing five attempts is a denial of service against that tenant. A success on one member's
account clears the **account** window and deliberately not the tenant one — otherwise the traffic
that proves the tenant is alive is also the traffic that resets its cap. Pass `orgLimiter` to
`defineAuth` to share those counters across replicas; unlike `limiter`, it is not required under
`scope: 'shared'`, because a tenant cap is a throughput ceiling and not a guessing allowance.

## Service-to-service

`verifyWorkloadToken` is the one function, and it reads all three shapes because they are all the
same JWT: a Kubernetes projected service-account token, a SPIFFE JWT-SVID, and a cloud IMDS token.
It is also the shape RFC 8693's `subject_token` takes.

```ts
const { identity } = await verifyWorkloadToken({
  token,
  issuers: ['https://kubernetes.default.svc'],
  audience: 'https://ledger.internal',
  keys: createJwksClient({ provider: 'k8s', jwksUri: 'https://kubernetes.default.svc/openid/v1/jwks' }),
  clock,
});
const actor = actorFromService(identity);   // kind: 'service', id: the caller's own sub
```

Signature first, then issuer, audience, `exp` and `nbf`. `scope` (space-delimited) or `scp` (an
array) become the actor's scopes; a token with neither carries none. There is no trusted-channel
exemption here — the token arrived in a header.

**mTLS is out of scope.** TLS termination is the mesh's job ([axiom
7](../../docs/idea/README.md)); the framework's part is reading a trusted
`x-forwarded-client-cert` through `@ultimat3/http`'s trusted-proxy seam, which that package owns.

`maxKeys` is not compared — it bounds one process' table, not a limit. A custom limiter therefore
does **not** own its own configuration: the policy stays the app's single statement of the limits,
and the boot check is what keeps it true.

**A shared limiter ships, `As of 2026-08`** — `postgresAuthLimiter({ executor, clock, policy })`,
two tables, a row per failure so the window still SLIDES across replicas. Until it landed,
`scope: 'shared'` was a declaration nothing in the framework could satisfy while `x new` scaffolded
`replicas: 2` — `maxAttempts × 2` guesses per account. `executor` is a `PgExecutor`, anything
speaking `query(text, values)`; **never `Bun.sql`**, whose `.query` is `undefined`.

```ts
import {
  type AuthAdapter,
  type AuthRateLimitPolicy,
  DEFAULT_AUTH_RATE_LIMIT,
  defineAuth,
  orgRateLimit,
  type PgExecutor,
  postgresAuthLimiter,
} from '@ultimat3/auth';
import { type Clock, systemClock } from '@ultimat3/core';
import { db, type SqlFragment } from '@ultimat3/db';

declare const adapter: AuthAdapter;
const clock: Clock = systemClock;

// The client this process already opened, wrapped in one line.
const client = db();
const executor: PgExecutor = {
  query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
    client.query<R>({ text, values } satisfies SqlFragment),
};

const rateLimit: AuthRateLimitPolicy = { ...DEFAULT_AUTH_RATE_LIMIT, scope: 'shared' };

defineAuth({
  adapter,
  clock,
  rateLimit,
  limiter: postgresAuthLimiter({ executor, clock, policy: rateLimit }),
  orgLimiter: postgresAuthLimiter({ executor, clock, policy: orgRateLimit(rateLimit) }),
});
```

Both limiters share one table: the keys are prefixed (`account:`, `ip:`, `org:`) and every limit
travels as a statement parameter, so the tenant bucket's wider allowance cannot leak into the
account bucket's. It reports `maxKeys: undefined` — there is no in-process table to bound — and
neither table forgets on its own.

**An app does not have to write any of that, `As of 2026-08-22`.** The boot fills a seam and every
`defineAuth` in the process picks it up:

```ts
import { configureAuthLimiters, type PgExecutor, postgresAuthLimiter } from '@ultimat3/auth';
import type { Clock } from '@ultimat3/core';

declare const bootExecutor: PgExecutor;
declare const bootClock: Clock;

// In the HOST, before the app's modules import.
configureAuthLimiters((policy) =>
  postgresAuthLimiter({ executor: bootExecutor, clock: bootClock, policy }),
);
```

A **factory** and not a limiter, because the host runs before the app: `defineAuth` compares what a
limiter enforces against what the app declared, so a limiter built at boot on the framework
defaults would be `X_AUTH_LIMITER_POLICY_MISMATCH` for every app that tuned its numbers. The
factory is called once per bucket, with the resolved policy, so the two halves cannot disagree.
Precedence is `defineAuth({ limiter })` → the installed factory → `createAuthLimiter`, and
`resetAuthLimiters()` puts the per-process default back. `@ultimat3/cli`'s `startServices` calls it
on every boot, so a scaffolded app gets a fleet-wide lockout with nothing to remember.

Neither table forgets on its own, and `purgeAuthLimits()` is the framework's reader for that:
it drops failures past the window and lockouts that have expired, measured against the clock the
host handed the limiter, and it sweeps only the WIDEST window installed — a sweep on a narrower
one deletes failures another limiter is still counting, which hands a sprayer its attempts back.
`@ultimat3/jobs`' `purge()` job is what calls it hourly; `x dev` and every role container declare
that sweep at boot.

## Providers are a registry, not a union

`OAuthProviderId` is `string`, and `registerOAuthProvider()` is the one way a provider gets in —
the three built-ins go through the same call. Before 1.3.0 the id was `keyof typeof
OAUTH_PROVIDERS` over `github | google | apple`, so an enterprise OP was **unrepresentable**: the
constraint was a type, there was no runtime escape, and the only ways out were forking the package
or bypassing OAuth entirely and losing PKCE, the sealed handshake, issuer pinning and account
linking with it.

```ts
import { discoverOAuthProvider, registerOAuthProvider } from '@ultimat3/auth';

// By hand, when you know the four endpoints:
registerOAuthProvider({
  id: 'bigco-sso',
  authorizeUrl: 'https://sso.bigco.test/oauth2/v1/authorize',
  tokenUrl: 'https://sso.bigco.test/oauth2/v1/token',
  userInfoUrl: 'https://sso.bigco.test/oauth2/v1/userinfo',
  userEmailsUrl: null,
  issuers: ['https://sso.bigco.test'],
  jwksUri: 'https://sso.bigco.test/oauth2/v1/keys',
  scopes: ['openid', 'email', 'profile'],
  usesPkce: true,          // the literal `true`; `false` does not typecheck, for anyone
  usesNonce: true,
  clientIdEnv: 'BIGCO_SSO_CLIENT_ID',
  clientSecretEnv: 'BIGCO_SSO_CLIENT_SECRET',
});

// Or read them once at boot, from the issuer's own discovery document:
registerOAuthProvider(await discoverOAuthProvider({ id: 'bigco-sso', issuer: 'https://sso.bigco.test' }));
```

| Call | Answers |
|---|---|
| `registerOAuthProvider(provider)` | the frozen provider; `X_OAUTH_PROVIDER_DUPLICATE` on a second claim of one id |
| `providerFor(id)` | the provider, or throws `X_OAUTH_PROVIDER_UNKNOWN` — never `undefined` |
| `hasOAuthProvider(id)` | whether the id is registered |
| `BUILTIN_OAUTH_PROVIDER_IDS` | the three shipped ids — the only list an **anonymous** refusal names |
| `oauthProviderIds()` | every registered id, live. **NOT** what `defineAuth({ providers })` defaults to — that is `[]`, so an app names what it enabled |

`discoverOAuthProvider` refuses a document with no `jwks_uri`: without a key set there is nothing
to check an id token's signature against, and the token-endpoint TLS exemption below is a thing a
caller declares, not one a provider inherits by omission.

**SAML is out of scope and will stay out of scope.** XML-DSig canonicalisation has no Bun native
and implementing it would mean a real dependency in the primitive vocabulary, which
[`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md) does not permit. The honest
answer is to put an OIDC-speaking SAML bridge (Okta, Entra, Keycloak, Dex, a SAML-to-OIDC proxy) in
front and register **that** as a provider.

## Id token signatures

`verifyIdToken({ keys })` is **required** to say where its trust comes from. There is no default,
because a default is what silently makes a second door as trusting as the first.

| `keys` | Means |
|---|---|
| `'token-endpoint-tls'` | this token came off a TLS response from the provider's own token endpoint — the one case OIDC Core 3.1.3.7 exempts. `exchangeOAuthCode` passes it, and that is the only shipped call site that may |
| a `JwksKeySource` | the signature is checked. `providerJwks(providerFor(id))`, or `createJwksClient({ provider, jwksUri })` |

```ts
const keys = providerJwks(providerFor('bigco-sso'));
const claims = await verifyIdToken({ provider: 'bigco-sso', idToken, clientId, nonce, clock, keys });
```

`crypto.subtle` covers RS256 and ES256, so this costs no dependency. `HS256` and `alg: none` are
refused before a key is even looked up — a symmetric algorithm verified against a *public* key set
is the classic algorithm-confusion forgery. Keys are cached by `kid` with a TTL and one unknown
`kid` triggers exactly one refetch, so a rotation heals itself.

Wire an unsolicited token — IdP-initiated login, `response_mode=form_post`, back-channel logout,
token exchange — to anything that does **not** check the signature and an attacker posts a
self-minted JWT with the right `iss`, your `aud`, a VP's `sub` and tomorrow's `exp`, and gets a
session. That is account takeover with no credential, and it is what this exists to stop.

## What an SSO user is allowed to do

`oauthLogin(auth, { resolveGrants })`. **Omit it and a first-time SSO user is created with
`roles: []` and `orgId: null`** — an actor every `can()` denies, and a tenant-scoped read that
throws before the query is built. SSO "works" and the person can do nothing until somebody runs
SQL, so the omission logs `auth.oauth.user_created_without_grants` rather than passing silently.

```ts
oauthLogin(auth, {
  resolveGrants: async (profile) => {
    const member = await directory.lookup(profile.email);
    return { orgId: member.orgId, roles: member.groups.map(toRole), scopes: [] };
  },
});
```

It is a **seam and not a group-to-role table**: which IdP group means which role is business
convention and business convention never ships ([axiom
8](../../docs/idea/19-mechanism-not-convention.md)). What the framework owns is calling it on
**every** login — so removing somebody from a group in the IdP takes effect at their next sign-in,
rather than never. A seam that returns the stored answer writes nothing.

## MFA — TOTP and recovery codes

Pure functions over a secret and a clock. This package mints, checks and de-duplicates a code;
**it persists nothing** — the secret, the recovery-code hashes and the spent steps are the app's
rows, because `AuthAdapter` has no MFA member and adding one would break every third-party
adapter.

```ts
import type { Auth } from '@ultimat3/auth';
import { createTotpReplayGuard, enrolTotp, generateRecoveryCodes, verifyTotp } from '@ultimat3/auth';
import { systemClock } from '@ultimat3/core';

declare const auth: Auth;   // the `defineAuth` at the top — `enrolTotp` reads `auth.mfa.issuer`

const enrolment = enrolTotp(auth, { account: 'ada@example.com' });   // issuer: auth.mfa.issuer
// enrolment.uri  -> otpauth://…  the QR code
// enrolment.secret -> base32, store it against the user

const recovery = generateRecoveryCodes();   // { codes, hashes } — show `codes` ONCE, store `hashes`
const guard = createTotpReplayGuard();

export function secondFactorHolds(userId: string, secret: string, code: string): boolean {
  const at = systemClock.now();
  const { ok, step } = verifyTotp({ secret, code, at });
  if (!ok || step === null || guard.isUsed(userId, step)) return false;
  guard.remember(userId, step, at);
  return true;
}
```

| Call | Answers |
|---|---|
| `enrolTotp(auth, { account, issuer?, secret? })` | `{ secret, uri, digits, periodSeconds }` — `issuer` omitted is `auth.mfa.issuer`, `secret` omitted mints one |
| `verifyTotp({ secret, code, at, drift?, usedSteps? })` | `{ ok, step }`. `step` is the window the code belonged to, `null` on no match |
| `createTotpReplayGuard(drift?, maxSubjects?)` | the in-process `{ isUsed, remember, size }`; a fleet passes a Redis-backed pair of the same two methods |
| `generateRecoveryCodes(count = 10)` | `{ codes, hashes }`. `codes` is shown once and is never re-derivable |
| `redeemRecoveryCode(code, hashes)` | the **remaining** hashes, or `null`. Persisting that array is what makes a code single-use |
| `totpStep(at, stepSeconds?)` / `totpCode(secret, step, digits?)` | the RFC 6238 halves, for a test that has to mint a valid code. `totpCode` throws `X_MFA_SECRET_INVALID` on a secret that decodes to zero bytes |

**A secret the decoder cannot read verifies nothing, `As of 2026-08`.** `base32Decode` answers
zero bytes for any character outside the alphabet and for `''`, and an HMAC keyed with zero bytes
is a valid HMAC — so `totpCode` used to hand back a six-digit code derived from no secret at all,
one stream *every* malformed row in the table verified against, computable by anyone. Three
answers now, and they differ because their callers do: `verifyTotp` returns `{ ok: false, step:
null }` (a broken stored credential is the generic failure, the rule `verifyAgainst` follows for a
hash Bun cannot read — never a throw into the login path, never an oracle); `totpCode` throws
`X_MFA_SECRET_INVALID`, because there is no code an unreadable secret is entitled to; and
`enrolTotp` throws the same code on an imported `secret`, so a value nothing can ever check never
reaches the table. A minted secret is readable by construction. Note the direction of the failure:
a `mfa_secret text not null default ''` column now locks that account out of its second factor
instead of accepting a code nobody had to know — re-enrol it with `enrolTotp(auth, { account })`.

`TOTP_DIGITS` (6), `TOTP_STEP_SECONDS` (30) and `TOTP_DRIFT_STEPS` (±1 window) are exported so an
app's own copy of the parameters cannot disagree with the verifier's.

A step is remembered per **subject**, not globally: a code is valid for `drift` windows either
side of now, so without the guard the same six digits log in twice inside a minute. `verifyTotp`
answers `{ ok: false, step }` — the step still named — when `usedSteps` already holds it, which is
how a replay is told apart from a wrong code.

The guard's table is **bounded** (`DEFAULT_MAX_TOTP_SUBJECTS`, 10,000), because a per-subject map
that only ever grows is one process' lifetime away from an OOM. A subject whose every remembered
step has fallen below the drift floor is *forgotten* — `verifyTotp` can never offer that step
again, so the entry answers exactly as a missing one — and only if that is not enough does the cap
evict live state, furthest from the live window first. The order is the guarantee: evicting a
subject makes a step they have already spent replayable, so the subject who just authenticated is
always the last one out.

**`mfa.required` is accepted only as `false`, and that is deliberate.** The field exists and is
typed as the literal `false`, so `required: true` is a compile error; a `true` that reaches
`defineAuth` from JavaScript or from JSON — where the type cannot — is refused at boot with
`X_CONFIG_INVALID` naming the key, never an unknown-key error and never a silent accept. Nothing
read it: both credential paths branch on `user.mfaSecret` alone, so an un-enrolled user was handed
a full session under a config that read as "this deployment requires a second factor". Enforcing it
at `login()` instead is a lockout — `actorFromUser` degrades only a user who HAS a secret, and this
package ships no enrolment route to send the rest to. Gate it in your own sign-in handler —
`if (user.mfaSecret === null)` send them to `enrolTotp` before you call `createSession`.

**The second leg of login is the app's, `As of 2026-08`.** `login()` and `completeOAuthLogin()`
throw `X_MFA_REQUIRED` before any session exists; finishing the flow is `verifyTotp` followed by
`createSession({ mfaSatisfied: true })` in the app's own route. The framework ships no
`POST /auth/mfa/verify`, deliberately — see [`CLAUDE.md`](CLAUDE.md) for the three things that
would have to land together, and why fewer is worse than none.

## Email verification and password reset

One issue/consume pair, two purposes. The token is mailed and only its `sha256` is stored, and
consuming it is a single conditional statement — the hash is an **argument to** the consume, never
a comparison after one.

```ts
import {
  consumeVerification,
  issueVerification,
  type MailSender,
  MemoryAdapter,
  type VerificationRuntime,
} from '@ultimat3/auth';
import { systemClock } from '@ultimat3/core';

declare const mail: MailSender;   // the app wires @ultimat3/mail's `send` here

const runtime: VerificationRuntime = { store: new MemoryAdapter(), clock: systemClock, mail };

const issued = await issueVerification(runtime, {
  purpose: 'password-reset',
  identifier: 'ada@example.com',       // the address; also the store key
  locale: 'en',
  link: (token) => `https://acme.test/reset?token=${token}`,
});

const verification = await consumeVerification(runtime, {
  purpose: 'password-reset',
  identifier: 'ada@example.com',
  token: issued.token,                 // in production this arrives off the link
});
```

| Name | Is |
|---|---|
| `VERIFICATION_PURPOSES` | `['email-verify', 'password-reset']` — the whole set, and `VerificationPurpose` is derived from it |
| `VERIFICATION_TEMPLATES` | purpose → **catalog key** (`auth.email-verify`, `auth.password-reset`), never copy: the body lives in the app's i18n catalog |
| `DEFAULT_VERIFICATION_TTL_MS` | 24 h for `email-verify`, 1 h for `password-reset` — a reset link is a password |
| `MailSender` | the injected port: `send(template, to, data, locale)`. `@ultimat3/mail` is tier 4 and this package is tier 2, so the app wires it |
| `issueVerification(runtime, input)` | `{ token, expiresAt }`. The token comes back for a test or a CLI; production only ever mails it |
| `consumeVerification(runtime, input)` | the `AuthVerification` row, or `X_UNAUTHENTICATED`. Unknown, spent, expired and mismatched are one answer |

One live token per `(purpose, identifier)`. A wrong guess destroys nothing: the store's
`takeVerification(purpose, identifier, tokenHash)` matches before it consumes, so an
unauthenticated POST with any token cannot kill the victim's live link.

## Revocation, offboarding and access review

| Call | Blast radius |
|---|---|
| `revokeSession(runtime, id)` | one session |
| `revokeOtherSessions(runtime, userId, keep)` | every session but the caller's |
| `revokeUserSessions(auth, userId, reason)` | one person, their current session included |
| `revokeOrgSessions(auth, orgId, reason)` | one tenant, at 03:00, without touching another |
| `revokeSessionsCreatedBefore(auth, at, reason)` | everything minted under a rotated secret |
| `disableUser(auth, userId, reason)` | stamps `disabledAt` **and** kills the sessions |
| `listOrgUsers(auth, orgId, { role })` | the quarterly access review, as safe summaries |
| `updatePrivileges(auth, userId, patch, session?)` | the grant, plus the session rotation it requires |

`reason` is a required argument on every revocation, for the reason `crossTenant()` requires one:
an incident review asks who killed these sessions and why, and a `delete` with no line answers
neither. Each one logs `auth.revocation` before it runs.

`deleteSessionsForOrg` joins through `x_users` and `x_sessions` deliberately does **not** gain an
`org_id`: a denormalised copy of the membership goes stale the moment somebody moves org, and a
stale row means the sweep leaves live exactly the sessions it was run to kill.

`describeUser` is an allow-list, never a delete-list — a column added to `AuthUser` later must not
appear in an admin response by default. No password hash, no TOTP secret, no recovery-code hash.

## Adapter seam

`AuthAdapter` (`adapter.ts`) is the only persistence interface. Better Auth binds here — it is
an adapter implementation, not a dependency of this package.

| Driver | Use |
|---|---|
| `BuiltinAdapter` | Postgres via `@ultimat3/db`; takes an injected `DbClient` |
| `MemoryAdapter` | `x new` before a database exists, and every test in this package |
| your own | implement `AuthAdapter`; DDL in `tables.ts` shows what the columns mean |

**An adapter stores and matches the address it is handed — it never folds case.** `x_users.email`
is a plain case-sensitive `text ... unique`, so an adapter that lowercased found accounts Postgres
would not. Normalisation happens once, above the seam, in `normaliseEmail` (`email.ts`): trim and
lowercase, nothing else. Call it before `findUserByEmail`/`createUser` in any login route of your
own, and key any bucket of your own with it — `accountKey` does.

The seam's newer members — `findUserByExternalId`, `listUsersByOrg`, `deleteSessionsForUser`,
`deleteSessionsForOrg`, `deleteSessionsCreatedBefore` — are **optional**, so a 1.2-era adapter
still satisfies the interface. Calling one an adapter has not implemented is `X_NOT_IMPLEMENTED`
with the method named, not a silent no-op.

`x_users` gained two columns in 1.3.0 — `scopes text[]` and `external_id text unique` — plus an
`org_id` index. `X_USERS_MIGRATION_1_3` is those statements for an app already on 1.2; both
columns are additive with a default, so the migration takes no table rewrite.

**Nothing wires those statements into a migration for you, `As of 2026-08`.** `AUTH_TABLES` is the
DDL as plain strings (`AUTH_TABLE_NAMES` is what they create, and `X_USERS_TABLE`,
`X_SESSIONS_TABLE`, `X_ACCOUNTS_TABLE`, `X_API_KEYS_TABLE`, `X_VERIFICATIONS_TABLE` are the
individual ones). `x db gen <name>` diffs `describeEntities()` against the newest migration's
snapshot — these tables are not `entity()` declarations, so nothing outside `tables.ts` reads the
constant and the command cannot see them. Paste each statement into its own file under
`packages/db/migrations/`, one statement per migration, then `x db migrate`.

## Sessions are not a write path

`verifySession` used to `UPDATE x_sessions … RETURNING *` on **every** authenticated request: one
request was a SELECT, a write and a second SELECT before the app's own first query. At 20k rps
that is 20k writes a second on one hot table, autovacuum falls behind, and the incident reads as
"the database is slow".

`SessionPolicy.idleSlideMs` — defaulting to `idleTtlMs / 20` — is how far `lastSeenAt` may drift
before a request writes it forward. A second request inside that window issues no write at all. A
changed IP or user agent is still written immediately, because that is the row a device list and
an incident review read. The trade is bounded and explicit: idle expiry is now precise to within
one `idleSlideMs`.

**Revocation is unaffected, and deliberately so.** `authenticate` re-reads the *user* row on every
request, so a revoked role takes effect on the very next one with no token-expiry lag — a better
property than any claims-in-a-JWT design. Throttling the session write is safe; caching the user
row would not be, and nothing does.

## Cookie

`__Host-x_session`, set by `sessionCookie(token, policy)`.

| Attribute | Attack it closes |
|---|---|
| `HttpOnly` | XSS reading `document.cookie` and exfiltrating the session |
| `Secure` | a network attacker lifting it off a plaintext request |
| `SameSite=Lax` | CSRF — the cookie is not attached to cross-site POSTs |
| `__Host-` + `Path=/` + no `Domain` | a sibling subdomain overwriting it (session fixation) |
| `Max-Age` | a client keeping it past the server's absolute ceiling |

## OAuth — log in with GitHub

`oauthLogin(auth)` **is** the flow. Two route descriptors, mounted at two fixed paths, composing
`beginOAuth`, the handshake cookie and `completeOAuthLogin`. Provider configs stay pure data —
importing `oauth.ts` performs no network I/O and reads no env.

```ts
const { start, callback } = oauthLogin(auth);

Bun.serve({
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/callback')) return callback.handle(request);
    if (pathname.startsWith('/auth/oauth/')) return start.handle(request);
    return new Response(null, { status: 404 });
  },
});
```

| | `start` | `callback` |
|---|---|---|
| path | `/auth/oauth/:provider` | `/auth/oauth/:provider/callback` |
| success | `302` to the provider, `Set-Cookie: __Host-x_oauth_<provider>` | `303` to `successPath`, `Set-Cookie: __Host-x_session` **and** the handshake cleared |
| failure | the coded JSON body, status per code | the same, handshake cleared either way |

A **descriptor**, never a mounted handler — the same category as `mcpHttpRoute()`. `@ultimat3/http`
is tier 2 like this package, so auth may not import it, and `defineRoute` is tier 4 and describes
a rendered page. A bare `Request` in, a `Response` out: drivable from a test, mountable by any
router that can match a `:param`.

**The `Bun.serve` above is library usage, not app usage.** An Ultimate app's server is `runRole`
(`apps/web/server.ts` is three lines that call it), and `As of 2026-08` `ServeOptions` has no
routes seam — the route list is built inside `serveApp` and closed. So a second `Bun.serve` in an
app does not extend that server, it stands beside it: on its own socket, outside the pipeline, and
therefore outside `configureAuthenticator`, the rate limiter, the security headers and the
SIGTERM drain. A login flow is the last surface that should be the one running unthrottled and
unheadered.

Until the seam exists, an app serving these descriptors serves them itself and pays for all of
that itself — a second port to publish and health-check, its own throttle in front of `callback`,
its own security headers, and a drain that does not strand a handshake mid-flight. There is no
mounting API to call today; do not write one, and do not read this section as promising one.

**The paths are not configurable.** `X_OAUTH_STATE_INVALID` has always told the caller to restart
at `GET /auth/oauth/<provider>`; it now quotes `oauthStartPath()`, the same declaration the mount
reads. A movable base path is that sentence going stale again.

**Failure is JSON, not a redirect carrying `?error=`.** The callback is the one request whose
failure a developer must read, and there is no `?next=` on the success hop either: an
attacker-supplied return target on the endpoint that hands out a session is the classic open
redirect, and `nextAfterSignIn` in `@ultimat3/http` is the one implementation of that check.

`beginOAuth` / `handshakeCookie` / `completeOAuthLogin` stay exported for a flow that needs the
seams — but they are the seams, not the path.

### Account linking

```ts
defineAuth({ adapter, providers: ['github'], link: 'verified-email' })  // the default
```

| `link` | a provider identity becomes an **existing** user when |
|---|---|
| `'verified-email'` (default) | the provider asserted the address verified **and** that account had verified it too |
| `'never'` | never — a collision is `X_UNAUTHENTICATED` and the caller uses their own credentials |

There is deliberately **no third value**. "Link on whatever address the provider sent" is not
spelled here at all: a provider that does not verify addresses turns it into account takeover —
register the victim's address there, press the button, inherit the account. Unrepresentable beats
explicit, the same way `PkcePair.method` is the literal `'S256'` and never `'plain'`. An app that
truly wants something looser wraps `signInWithOAuth` and resolves the user itself.

The handshake carries `state`, `nonce` and the PKCE verifier across two requests, so it needs a
home. `handshakeCookie` is that home — sealed with `SESSION_SECRET`, `HttpOnly; Secure;
SameSite=Lax` under a `__Host-` name, and expired against the server's clock rather than the
client's copy of `Max-Age`. `sealHandshake` / `openHandshake` are the same codec without the
cookie, for an app that would rather keep it server-side.

**One cookie per provider:** `handshakeCookieName(provider)` → `__Host-x_oauth_github`. A browser
is one cookie jar and a user is allowed two tabs, so a single shared name means the `google`
redirect overwrites a `github` handshake still in flight — and the github callback then opens
google's and fails `X_OAUTH_STATE_INVALID` for a reason no restart clears. `handshakeCookie` takes
the name off `handshake.provider`, `clearHandshakeCookie(provider)` clears only that provider's,
and `readHandshakeCookie(request, provider)` reads only that provider's. Pass `{ name }` to
override all three at once.

| Refused | Because |
|---|---|
| a handshake with no signature, or one signed with another secret | a browser that can mint a handshake can pair its own code with someone else's session |
| a `github` handshake opened on the `google` callback | `openHandshake(sealed, provider)` requires the provider, so it cannot be forgotten |
| a handshake older than `DEFAULT_HANDSHAKE_TTL_MS` (10 min) | a client may ignore `Max-Age`; the server's clock decides |
| a callback with no handshake cookie | there is nothing to check `state` against |
| a cookie value that is not valid percent-encoding | the header is the client's; the raw value reaches the signature check and fails it, never a bare `URIError` |

| Provider | PKCE | id token | Env |
|---|---|---|---|
| `github` | S256 | — profile + verified-emails call | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` |
| `google` | S256 | required, nonce-bound | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| `apple` | S256 | required, nonce-bound | `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` |

Apple alone rejects a static secret: `APPLE_CLIENT_SECRET` must hold the ES256 client-secret
JWT signed with the `.p8` key, which Apple expires every six months.

| Step | Does | Fails with |
|---|---|---|
| `oauthLogin(auth)` | the two routes: redirect out, session back | `X_OAUTH_PROVIDER_UNKNOWN`, `X_OAUTH_DENIED` |
| `handshakeCookie` / `readHandshakeCookie` | seals the handshake onto the redirect, opens it on the callback | `X_OAUTH_STATE_INVALID`, `X_ENV_MISSING` |
| `exchangeOAuthCode` | POSTs the code + PKCE verifier, verifies the id token | `X_OAUTH_EXCHANGE_FAILED`, `X_OAUTH_TOKEN_INVALID` |
| `oauthProfile` | id-token claims, else userinfo → one normalised identity | `X_OAUTH_EXCHANGE_FAILED` |
| `signInWithOAuth` | links the account, applies MFA, mints the session | `X_UNAUTHENTICATED`, `X_MFA_REQUIRED` |

- PKCE's verifier travels only in the exchange — it proves the code belongs to the browser
  that started the flow.
- `state` is checked before anything reaches the network; `nonce` is checked inside the id
  token, because that is where the code flow actually carries it.
- GitHub reports a bad, reused or expired code as **HTTP 200 with an `error` field**. Trusting
  the status alone there mints a session from a failed exchange.
- An address is only linked to an existing account when **both** sides verified it (`link:
  'verified-email'`). Otherwise whoever registered the address first inherits the login.

## API keys — how an agent authenticates

`ult_<env>_<id>_<secret>`. The plaintext is shown once; the row holds `sha256(secret)` and is
looked up by the non-secret id.

```ts
const { plaintext, record } = issueApiKey({ env: 'prod', scopes: ['post:publish'], orgId });
await auth.adapter.putApiKey(record);
const actor = apiKeyActor(await verifyApiKey(auth.adapter, plaintext));  // kind: 'agent'
```

An api key's scopes become **exactly** the agent actor's scopes — never the owning user's roles.

## Errors

| Code | When |
|---|---|
| `X_UNAUTHENTICATED` | no actor, unknown session, or any failed credential path |
| `X_SESSION_EXPIRED` | idle or absolute expiry, named in `cause` |
| `X_MFA_REQUIRED` | password proven, second factor outstanding |
| `X_OAUTH_STATE_INVALID` | state, nonce or PKCE verifier did not match |
| `X_OAUTH_EXCHANGE_FAILED` | the provider refused the exchange, or returned no usable identity |
| `X_OAUTH_TOKEN_INVALID` | the id token failed its signature, issuer, audience or expiry check, or no key in the published set matched its `kid` |
| `X_OAUTH_PROVIDER_UNKNOWN` | the URL named a provider nothing registered, one `defineAuth({ providers })` did not enable, or one whose `*_CLIENT_ID`/`*_CLIENT_SECRET` are unset — all three answer 404 with the same body, because telling an anonymous caller which is which describes this deployment for free. The real reason is logged. The refusal lists only the three built-ins, never your registry |
| `X_OAUTH_PROVIDER_DUPLICATE` | two `registerOAuthProvider` calls claimed one id — at boot, never at a login |
| `X_OAUTH_DENIED` | the user pressed Cancel, or the provider declined — `403`, never a `502` |
| `X_PASSWORD_WEAK` | strength check rejected the password |
| `X_ACCOUNT_LOCKED` | the per-ip, per-account or per-org bucket is inside its lockout |
| `X_API_KEY_INVALID` | key unknown, revoked, expired or wrong |
| `X_ENV_MISSING` | `oauthCredentials()` found no client id or secret for an enabled provider |
| `X_NOT_IMPLEMENTED` | an `AuthAdapter` has not implemented an optional seam member (`revokeOrgSessions`, `listOrgUsers`, …), or lost a write it accepted — `emailVerifiedNotStored(provider, userId)` when `updateUser` drops the OAuth verified stamp |

```bash
bun test packages/auth
bun run --filter @ultimat3/auth typecheck
```
