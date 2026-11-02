# 25 — A spent TOTP code stays spent across replicas

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`auth`), 5 (`cli`). **Security.**

## Why
Same six digits on a second replica sign in. Probe, two `defineAuth` over one adapter: replica A first use `session`, replica A replay `X_UNAUTHENTICATED`, replica B replay `session`.
The documented way out cannot work. `TotpReplayGuard` is synchronous (`packages/auth/src/mfa.ts:194-197`), the README says a fleet passes "a Redis-backed pair of the same two methods". Probe, guard with async methods, unused step, right code: `X_UNAUTHENTICATED`, because a `Promise` is truthy at `mfa-challenge.ts:122`. Everyone is locked out.
One adopter skipped `completeMfa` for this reason and rebuilt the second leg in Postgres (`on conflict (user_id, step) do nothing`). Lockouts already got the same fix (`packages/cli/src/runtime-services.ts:387`). The default scaffold runs two replicas.

## Files to change
- `packages/auth/src/mfa.ts:194` — `TotpReplayGuard` becomes one atomic method; `isUsed` and `remember` cannot be made atomic across a network.
- `packages/auth/src/mfa-challenge.ts:120-125` — verify, then await the claim; a lost claim is the same refusal.
- `packages/auth/src/mfa-replay-postgres.ts` — new; guard plus `SQL_TOTP_REPLAY_TABLE`.
- `packages/auth/src/auth.ts:243` — default reads the installed factory, then memory.
- `packages/auth/src/limiter-install.ts` — `configureTotpReplay`, beside `configureAuthLimiters`.
- `packages/cli/src/runtime-services.ts:387` — install the Postgres guard over the same executor.
- `packages/cli/src/framework-schema.ts:86` — apply the table.
- `packages/cli/src/runtime-purge.ts` — hourly sweep of steps past the drift window.
- `packages/auth/README.md:385-510`, `packages/auth/CLAUDE.md`, `wiki/Auth.md` — the new row, and delete the "Redis-backed pair" sentence.

## Steps
1. `TotpReplayGuard.claim(subject, step, at): Promise<boolean>`. `true` first time, `false` for a replay.
2. `memoryTotpReplayGuard` implements `claim`, keeping its bound and eviction order. `isUsed` stays on `MemoryTotpReplayGuard` for tests.
3. `postgresTotpReplayGuard({ executor })`: table `x_totp_steps (subject text, step bigint, used_at timestamptz, primary key (subject, step))`; `insert … on conflict do nothing returning 1`.
4. `completeMfa`: claim only after the code verified, so a wrong guess never writes. A store that fails throws, as `apiKeyResolver` does: a down database is not a wrong code.
5. `defineAuth` refuses a `totpReplay` with no `claim` function, naming the key.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_CONFIG_INVALID` (existing) | `totpReplay` has no `claim`, a guard written for the old shape | replace `isUsed`/`remember` with `claim(subject, step, at)`, or drop the option on a framework-booted process |

## Tests
- `packages/auth/src/mfa-challenge.test.ts`: two `defineAuth` sharing one guard, second use refused. Fails today on the claim's absence.
- `packages/auth/src/mfa-replay-postgres.live.test.ts`: 20 concurrent claims of one step, exactly one `true`; a second subject unaffected.
- `packages/cli/src/runtime-services.test.ts`: a booted process's `defineAuth` holds the Postgres guard.
- `bun test packages/auth/src/mfa-challenge.test.ts`; `bun run framework-tables`.

## Semver
Breaking, one row. Upgrading: a custom `totpReplay` replaces `isUsed`/`remember` with `claim`. A framework-booted app needs no edit; the table is applied at boot.

## Done when
- The two-replica probe's third answer is `X_UNAUTHENTICATED`, on the memory guard shared and on Postgres.
- No text in the repo says a guard is "a pair of the same two methods".
- `bun run verify` green.
