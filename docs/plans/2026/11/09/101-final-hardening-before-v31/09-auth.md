# 09 — auth: API keys that scale, codes that resist burning

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`auth`).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| A1 | Med (perf) | `auth/src/api-keys.ts` (`verifyApiKey` → `touchApiKey`), `auth/src/builtin-adapter.ts:441` | every API-key request runs `UPDATE x_api_keys SET last_used_at` on one row: N req/s = N row-locked writes plus WAL and dead tuples | touch only when `now - lastUsedAt ≥ 60 s`, mirroring sessions' `idleSlideMs` (`auth/src/session.ts:209`) |
| A2 | Low | `auth/src/api-keys.ts` (`verifyApiKey`) | the parsed `env` segment is never compared with `record.prefix`: a `dev` key presented as `ult_prod_…` verifies, so the triage label is forgeable | compare; mismatch is the same refusal as a bad key |
| A3 | Low (v31) | `auth/src/grant-authorization-code.ts:33-49` | `takeCode` consumes the code before checking client, PKCE verifier and `redirect_uri`. One wrong request burns an intercepted code; a second revokes the grant via the replay path (DoS of that login). RFC-legal | check `clientId` (and PKCE) before marking used |
| A4 | Low (verify) | `auth/src/grant-device.ts` | same ordering question as A3, unread in depth | write the A3 test against the device grant; fix the same way if it fails |

## Files to change
- `packages/auth/src/api-keys.ts`, `builtin-adapter.ts`, `memory-adapter.ts` (parity) — A1, A2.
- `packages/auth/src/grant-authorization-code.ts`, `grant-device.ts` — A3, A4.
- `packages/auth/README.md` — key touch granularity.

## Tests
- `api-keys.test.ts`: two verifies inside 60 s → one `touchApiKey` (spy on the memory adapter); env-segment mismatch refused.
- `grant-authorization-code.test.ts`: a different client presenting the code leaves it redeemable by the real client.
- `grant-device.test.ts`: same.
- `bun test packages/auth`

## Done when
- The four tests above are green on memory and Postgres adapters (`*.live.test.ts` in CI).
