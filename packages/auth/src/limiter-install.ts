// Single responsibility: the ONE ambient install point for where failed credential attempts are
// counted, plus the purge over whatever it built.
//
// WHY a seam and not a `defineAuth` argument: `defineAuth` is the APP's call, and the app is not
// the thing that knows which database this process opened. A host boot resolves the pool long
// before it imports app modules (`@ultimat3/cli`'s `startServices` runs before `loadApp`), so
// until this existed `postgresAuthLimiter` shipped with nowhere to be installed from — account
// lockouts stayed per-pod while the shipped chart runs three `web` replicas, and an attacker got
// N x the lockout budget by spreading a spray across them.
//
// WHY a FACTORY and not a limiter: `defineAuth` compares what a limiter reports against what the
// app declared (`assertAuthLimiterPolicy`), and the boot cannot know the app's `maxAttempts`,
// `windowMs` or `lockoutMs` — it has not imported the app yet. Handing over a built limiter would
// make every app that tunes its own numbers fail at boot with `X_AUTH_LIMITER_POLICY_MISMATCH`.
// The factory is called WITH the resolved policy, so the two halves cannot disagree.

import type { AuthLimiter, AuthRateLimitPolicy } from './rate-limit';

/**
 * Build a limiter enforcing exactly `policy`. Called once per bucket — the account/IP bucket and
 * the tenant bucket are separate instances over one store, because they enforce different
 * `maxAttempts` and their keys are prefix-disjoint (`account:` / `ip:` / `org:`).
 */
export type AuthLimiterFactory = (policy: AuthRateLimitPolicy) => AuthLimiter;

let factory: AuthLimiterFactory | undefined;
/** Every limiter this process built through the factory above, so a purge can reach them. */
let built: AuthLimiter[] = [];

/**
 * The ONE install point, the same shape as `configureKdfGate` beside it: a host that owns the
 * database connection says where failed attempts are counted, and every `defineAuth` in the
 * process picks it up without the app declaring anything.
 *
 * A second install replaces the first and forgets what the first built — a limiter over a pool
 * the previous boot has closed is not something a purge should still be sweeping through.
 */
export function configureAuthLimiters(next: AuthLimiterFactory): void {
  factory = next;
  built = [];
}

/** Back to `createAuthLimiter`, the per-process default. A host that installs one calls this on stop. */
export function resetAuthLimiters(): void {
  factory = undefined;
  built = [];
}

/**
 * `defineAuth`'s reader, and deliberately NOT exported from `src/index.ts`: a second caller
 * building limiters out of band would be a second answer to "where are failures counted", which
 * is the ambiguity axiom 1 refuses. `undefined` means no host installed one, and the caller falls
 * back to the in-memory limiter.
 */
export function installedAuthLimiter(policy: AuthRateLimitPolicy): AuthLimiter | undefined {
  if (factory === undefined) return undefined;
  const limiter = factory(policy);
  built.push(limiter);
  return limiter;
}

/** A limiter that keeps rows somebody else has to delete. The memory limiter sweeps itself. */
type PurgingAuthLimiter = AuthLimiter & { purgeExpired(): Promise<number> };

const canPurge = (limiter: AuthLimiter): limiter is PurgingAuthLimiter =>
  typeof limiter.purgeExpired === 'function';

/**
 * Drop every failure past the window and every expired lockout the installed limiters left
 * behind, and answer how many rows went. `0` when nothing was installed, or when what was
 * installed keeps no rows.
 *
 * The WIDEST window wins, and only that limiter is swept. Every limiter here writes to the same
 * two tables, so sweeping the narrow one would delete failures the wide one is still counting —
 * which is a sprayer buying attempts back from the cleanup job. The same defect the http store's
 * `purgeExpired(nowMs)` exists to prevent, one level up.
 *
 * No `nowMs` argument, unlike `postgresRateLimitStore.purgeExpired`: a limiter built through this
 * seam already holds the clock its host handed it, and that is the clock every `at_ms` in those
 * tables was written from. A second clock at the call site is exactly the mismatch that reads a
 * frozen test clock as a 20,000,000-second refill.
 */
export async function purgeAuthLimits(): Promise<number> {
  let widest: PurgingAuthLimiter | undefined;
  for (const limiter of built) {
    if (!canPurge(limiter)) continue;
    if (widest === undefined || limiter.policy.windowMs > widest.policy.windowMs) widest = limiter;
  }
  return widest === undefined ? 0 : await widest.purgeExpired();
}
