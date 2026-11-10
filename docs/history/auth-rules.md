# auth: rule text moved out of `packages/auth/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file toward a 20 KB working target (the
enforced ceiling is 24,576 B, `bun run scripts/claude-md-size.ts`). Each section below is a bullet
as it stood, verbatim; the package file keeps a one-line rule marked `†`. Where the two disagree,
`packages/auth/CLAUDE.md` wins.

## Every number is screened

- **Every number this package bounds anything with is screened** (`policy-numbers.ts`): policy
  numbers at `defineAuth` (`X_CONFIG_INVALID` — `session.absoluteTtlMs`, `idleTtlMs`,
  `idleSlideMs`, `password.minLength`, the two argon2 costs, every `rateLimit` number), and every
  runtime one through `assertFiniteAuthCount` — `jwks.ttlMs`, the three OAuth legs' `timeoutMs`
  (screened OUTSIDE each leg's `try`), the limiter's `maxKeys`, `mfa.drift`,
  `oauth.handshake.ttlMs`, `session.cookie.maxAgeSeconds`, `kdf.maxConcurrent`/`maxQueued`.
  **`mfa.drift` and the KDF gate are the two that HANG** — mutate `verifyTotp` with the
  `NaN` case, never by deleting the screen (that wedges `mfa.test.ts`).

## An unreadable stored hash

- **A stored hash Bun cannot read is the generic failure, and it burns the same KDF.**
  `verifyAgainst` (`password.ts`) answers `null` for `Bun.password.verify`'s throw (unsupported
  algorithm, malformed PHC) and `''`, joining the no-user branch; nothing is logged. An
  `X_OVERLOADED` from the gate is RE-THROWN (a shed is load, not a verdict). Supported-but-old
  (bcrypt) stays a verdict and `needsRehash` flags it. `password.test.ts` pins both halves.

## `AuthLimiter` is a reservation

- **`AuthLimiter` is async on every member, declares the policy it enforces, and is a
  RESERVATION.** `reserve(key)` counts the attempt in the step that admits it (refused, counting
  nothing, while locked); `refund(reservation)` gives ONE back and lifts a lockout the window no
  longer justifies; `recordSuccess(key)` clears the key. There is no check-then-record pair: N
  concurrent guesses all passed the check. `assertAuthLimiterPolicy` (once, in `defineAuth`)
  refuses a per-process limiter under `scope: 'shared'` (`X_AUTH_LIMITER_NOT_SHARED`) and different
  `maxAttempts`/`windowMs`/`lockoutMs` (`X_AUTH_LIMITER_POLICY_MISMATCH`). `maxKeys` is not
  compared.

## `openLoginAttempt`

- **Every credential check runs through `openLoginAttempt`** (`login-attempt.ts`): account → ip →
  org reserved in that fixed order BEFORE the KDF or the TOTP compare. A failure calls nothing (the
  reservations are the record); `release()` for no verdict (a shed KDF, a store that is down, a
  bucket that refused) or a factor proven with another still owed; `succeed()` clears the account
  and refunds the shared two.

## `postgresAuthLimiter`

- **`postgresAuthLimiter` is the shared limiter: ONE row per key in `x_auth_lockouts`, holding the
  instants still inside the window** (`attempts_ms bigint[]` — a sliding window). The take is one
  `insert … on conflict do update` reading the window off `x_auth_lockouts.<column>`, never a CTE
  and never a second table: only the row the statement locks is re-read after a wait. No row back is never an
  admission; a live lockout is never rewritten. Full rule: `docs/history/auth.md`. `PgExecutor` (`@ultimat3/core`'s, re-exported) is structural:
  the pool is the host's.

## `installAuthLimiters`

- **`installAuthLimiters` is the HOST's install point and takes a FACTORY** — on
  `@ultimat3/auth/adapter` (`adapter-subpath.ts`) with `installTotpReplay`, never `.` (v31), called with the
  RESOLVED policy once per bucket; the comparison still runs on what comes back. Precedence:
  `config.limiter` → the installed factory → `memoryAuthLimiter`. `installedAuthLimiter` and
  `installedLimiterCount()` are NOT in `src/index.ts`. `purgeAuthLimits()` sweeps only the
  **widest** window among the built limiters (retained one per `windowMs` in a `Map`), on the
  limiter's own clock. `AuthLimiter.purgeExpired` is optional.

## `normaliseEmail`

- **`normaliseEmail` is the ONE normalisation, it lives ABOVE the `AuthAdapter` seam, and no adapter
  may fold case.** Every door now normalises before the adapter sees the address — `register`,
  `login`, `profileEmail` in `oauth-login.ts`, `accountKey`, and `issueVerification`/
  `consumeVerification`. Trim and lowercase only; never strip a `+tag` or a gmail dot.
  `@ultimat3/testing/conformance`'s `authAdapterConformance` pins both adapters.

## One sign-in route implementation

- **One sign-in route implementation** (`identity-provider-route-core.ts`): `identityProviderRoutes`
  and `oauthLogin` are two policies over it, at `/auth/sso/:provider[/callback]` (`oauth-paths.ts`,
  imports nothing, not configurable; every "start over" fix is `restartAt(provider)`). Descriptors,
  never mounted handlers. Failure is **coded JSON** (`code`, `title`, `docs`, one fixed `cause`,
  `fix: x errors explain <CODE> --json`); the authored cause/fix is the `<event>.refused` log line.
  Success is 303 to a fixed `successPath`, never `?next=`. `__Host-x_sso_<id>` clears only for an
  answer bound to it (`answers()`). The ACS `meta` is `csrf: 'cookieless'`; mount `meta: leg.meta`.

## `x_users.mfa_secret` is sealed

- **`x_users.mfa_secret` is SEALED** (`mfa-secret.ts`, purpose `auth:x_users.mfa_secret`):
  `saveTotpSecret` writes, `openTotpSecret` reads and REFUSES a value core's `isSealed` does not
  recognise (`X_MFA_SECRET_UNSEALED`, fix `x auth seal-mfa --json`). No plaintext fallback, ever. Full rule: `docs/history/auth.md`.

## Memory adapter uniqueness and clock

- **`MemoryAuthAdapter.createUser` and `updateUser` enforce `x_users.id`, `email` and `external_id`
  uniqueness** (`authUniqueViolation`, `X_AUTH_WRITE_FAILED`), NULLS DISTINCT like Postgres;
  `PostgresAuthAdapter` answers the same code through `builtin-adapter-violation.ts`.
  **`MemoryAuthAdapter` takes a `Clock`** (default `systemClock`) and stamps every instant from it.
  `authAdapterConformance` (`@ultimat3/testing/conformance`) pins both.

## An api key is its owner's credential

- **An api key is its owner's credential.** `verifyApiKey` re-reads the owner (after the secret
  matched, never before) and refuses a missing or disabled one as the same `X_API_KEY_INVALID`; a
  key with `userId === null` has no owner and is unchanged. `disableUser` revokes the user's live
  keys beside their sessions, and logs before its first write.

## A key's scopes only ever shrink

- **A key's scopes only ever shrink** (`apiKeyScopes`, `policy-bridge.ts`): `*` and `<res>:*` are
  refused at `issueApiKey` (`X_CONFIG_INVALID`) and dropped from a stored row; an OWNED key keeps
  only what its owner's grants cover (core's `grantCovers`, never a local copy). Roles are policy's to expand, so the default grants are the
  row's `permissions` + `scopes` (`directGrants`) and a role-based app passes
  `apiKeyResolver(store, { grantsOf })`. Never union a key with the owner's roles.

## `apiKeyResolver`

- **`apiKeyResolver(() => store)` is the ONE token → caller mapping** (`api-key-resolver.ts`):
  `verifyApiKey` → `apiKeyActor`, `X_API_KEY_INVALID` → `null`, everything else rethrown. Its
  `ApiKeyCaller` is structurally http's `BearerCaller` and mcp's `ResolvedToken` — declared here
  because tier 2 imports neither. The store is a thunk (a mount is declared before boot installs
  the database client). No second in-memory key store: `MemoryAuthAdapter` IS an `ApiKeyStore`.

## Session rotation

- Rotate the session id on any privilege change (`rotateSession`, called by `updatePrivileges` in
  `privileges.ts`), never patch the row. A `passwordHash` change also ends every OTHER session of
  that user (`deleteOtherSessions`), or all of them when the caller passed no session of theirs.
  **A new id, never a new lifetime**: rotation carries `createdAt` and `absoluteExpiresAt` over
  (`createSession` clamps both, so they only shorten), and the rotated cookie's `Max-Age` is
  `remainingMaxAgeSeconds` — `session-rotation.test.ts` pins both adapters.

## `kdfGate()`

- **Every argon2 call goes through `kdfGate()`** — width 8, queue 64, `X_OVERLOADED` past it
  (borrowed from http, in `AUTH_BORROWED_ERROR_CODES`). The pool is core's `flightGate`, the
  refusal auth's own through core's `overflow:` seam. `installKdfGate()` (`@ultimat3/auth/adapter`,
  answers its release, v31) is the ONE install point and deliberately not a `defineAuth` key.

## Passkeys

- **Passkeys are verified by hand** (`passkey-*.ts`, `cbor.ts`, `cose-key.ts`, `webauthn-data.ts`):
  UV required, origin exact, the key's alg (never the assertion's), counter non-regression by
  compare-and-set, challenges single-use in `x_passkey_challenges` (never a process map). A step-up
  challenge is DERIVED (`stepUpChallenge`), never supplied. Browser half: `./client`, two modules
  (`client-bundle.test.ts`); never import the barrel there. `docs/history/auth.md`.

## `completeMfa`

- **MFA's second leg is `completeMfa(auth, challenge, code)`** (`mfa-challenge.ts`). `X_MFA_REQUIRED`'s
  `meta.challenge` is a `seal()` value, never a bare user id; the code is reserved against the three
  buckets before it is compared; a recovery code is consumed by one conditional UPDATE. Full rule: `docs/history/auth.md`.
