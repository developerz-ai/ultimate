# 05 — auth

> Part of [`overview.md`](overview.md). Depends on: 01. Tier: 2. Path-disjoint from 04.
> Security rows — stated at fix level. See the overview's public-repository risk.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/auth/src/api-keys.ts:92-109` | `verifyApiKey` loads the owner when `record.userId !== null`; refuses a missing or disabled one | `s1-sec H1` |
| `packages/auth/src/revocation.ts:84-95` | `disableUser` revokes the user's keys; checks the optional method and calls `record` **before** `updateUser` | `s1-sec H1`, `s2-ja` low |
| `packages/auth/src/privileges.ts:48-74` | a `passwordHash` change calls `deleteOtherSessions(userId, keep)` (`session.ts:205`), or `deleteSessionsForUser` with no session | `s1-sec M1` |
| `packages/auth/src/auth.ts:285-305`, `rate-limit.ts`, `rate-limit-postgres.ts` | the limiter is a reservation: count before the KDF, refund on success; the Postgres store does it in one statement | `s2-con #4`, `s2-sec H2` |
| `packages/auth/src/auth.ts:307`, `:338`, `mfa.ts:164-191`, `errors.ts:165-182` | ship `completeMfa(auth, challengeToken, code)` over a short-lived sealed challenge and `auth.limiter`; `login` does not `recordSuccess` before the second factor | `s1-sec M9` (narrowed in `s3-be`) |
| `packages/auth/src/policy-bridge.ts:72-95` | scopes intersected with the owner's grants; `*` and `res:*` refused at issue | `s1-sec L3` |
| `packages/auth/src/tables.ts:41` | `mfa_secret` sealed, `purpose: 'auth:x_users.mfa_secret'` | `s1-sec L4` |
| `packages/auth/src/builtin-adapter.ts:135-147` | catch the unique violation, rethrow `authUniqueViolation` | `s1-t23 #7` (REPRODUCED) |
| `packages/auth/src/memory-adapter.ts` (`updateUser`) | `external_id` / `email` uniqueness | `s1-t23` gaps |
| `packages/auth/src/builtin-adapter.ts` (`takeVerification`) | `consumed_at` from the injected `Clock` | `s1-t23` gaps |
| `packages/auth/src/jwks.ts:196-213` | a set with zero importable keys is a failed fetch; keep the old keys | `s2-ja` low |
| `packages/auth/src/oauth-exchange.ts:254-261` | `renderCauseValue` + `MAX_DETAIL_LENGTH` on the 200-with-error branch | `s2-ja` low |
| `packages/auth/src/oauth-discovery.ts:113,150` | the document's `issuer` compared to the input | `s2-ja` low |
| `packages/auth/src/oauth-route.ts:134-156,247-250` | public errors carry code + fixed sentence; no secret length; `redirect_uri` needs `APP_URL` | `s1-sec L8` |
| `packages/auth/src/errors.ts` (`X_ACCOUNT_LOCKED`) | the cause names no org id | `s3-be` New 3 |
| `packages/auth/src/verify.ts:4` | header: mail is tier 4 — the seam is a structural `MailSender`, not a sideways edge | `s2-arch` drift |

## Steps
1. H1 first. The adapter read is one extra lookup per key verification; reuse the `disabledAt` check the session path makes at `packages/auth/src/auth.ts:362`. A key with `userId === null` (service key) is unchanged.
2. Lockout reservation: pattern `packages/realtime/src/live-query.ts:167`; SQL shape `packages/http/src/rate-limit-postgres.ts:72`. The test is a `Promise.all` burst of 40 against `maxAttempts: 5` — at most 5 reach the KDF. The org-wide bucket's *policy* (`s1-sec M8`) is intended and pinned (`auth-lockout.test.ts:31-50`) — do not change it; only remove the org id from the cause.
3. `completeMfa`: the challenge is a `seal()` value (purpose `auth:mfa-challenge`) binding `userId`, a nonce and an expiry. Rewrite `X_MFA_REQUIRED`'s `fix:` to name it. Shipped code text changes; the code itself does not.
4. Sealing `mfa_secret` needs a data migration in each app: `x_users` is a framework table — the DDL and the transitional read of legacy plaintext follow the sealed-column precedent (`packages/entity/src/sealed-column.ts`, plan 2026/10/01 slice 03). auth is tier 2 and `seal()` is core: no new edge.
5. OAuth Apple provider (`s2-ja #9`, `s3-be` New 4) is **not** fixed here — it needs a POST callback leg and a cookie that survives it. Slice 15 decides ship-or-remove; until then `oauth-builtins.ts:42-58` gets a header saying the flow is unproven.

## Tests
- `packages/auth/src/api-keys.test.ts`, `revocation.test.ts`, `privileges.test.ts`, `auth-lockout.test.ts`, `mfa.test.ts`, `policy-bridge.test.ts`, `adapter-parity.test.ts` (scripted `DbClient` throwing the 23505 shape — and PGlite, as `s3-be` ran), `jwks.test.ts`, `oauth-exchange.test.ts`.
- `packages/auth/src/rate-limit-postgres.live.test.ts` — the burst on Postgres.
- `bun test packages/auth`

## Owned elsewhere
- Optional adapter capability methods (`packages/auth/src/adapter.ts:73-81,115-123`, `s1-arch #11`) — required in the next major; slice 15.
- The demo app's hand-written auth (`s2-arch H5`, `s2-sec M6, L10`) — slice 15.

## Done when
- A disabled user's key is refused on the bearer mount and on MCP.
- A password change leaves one session. 40 concurrent wrong guesses lock at `maxAttempts`.
- A second factor can be completed with framework code only; TOTP guesses are metered.
- `wiki/Upgrading.md` carries the behaviour changes; `bun run changelog-check` green.
