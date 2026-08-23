// The seam that makes a shared limiter installable at all. Every case here is a claim about
// PRECEDENCE or about which policy the factory is handed — the two things a host boot cannot get
// right on its own, because it runs before the app that declares the numbers.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { defineAuth } from './auth';
import {
  configureAuthLimiters,
  installedLimiterCount,
  purgeAuthLimits,
  resetAuthLimiters,
} from './limiter-install';
import { MemoryAdapter } from './memory-adapter';
import type { AuthLimiter, AuthRateLimitPolicy } from './rate-limit';
import { createAuthLimiter, DEFAULT_AUTH_RATE_LIMIT } from './rate-limit';

/** A limiter that answers nothing and counts its sweeps — the store behind it is not the subject. */
function tableLimiter(
  policy: AuthRateLimitPolicy,
  rows: number,
): AuthLimiter & { readonly sweeps: () => number } {
  let sweeps = 0;
  return {
    policy: { ...policy, maxKeys: undefined, scope: 'shared' },
    sweeps: () => sweeps,
    assertAllowed: async (): Promise<void> => undefined,
    recordFailure: async (): Promise<void> => undefined,
    recordSuccess: async (): Promise<void> => undefined,
    lockedUntil: async (): Promise<Date | null> => null,
    reset: async (): Promise<void> => undefined,
    purgeExpired: async (): Promise<number> => {
      sweeps += 1;
      return rows;
    },
  };
}

const adapter = (): MemoryAdapter => new MemoryAdapter();

/** Rows a sweep of that window would remove — distinct per window, so the count names the sweeper. */
const rowsFor = (windowMs: number): number =>
  windowMs === 1_800_000 ? 11 : windowMs === 900_000 ? 7 : 3;

const codeOf = (call: () => unknown): string => {
  try {
    call();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${typeof error}`;
  }
  return 'did-not-throw';
};

afterEach(() => {
  resetAuthLimiters();
});

describe('configureAuthLimiters', () => {
  test('an app that declares nothing gets the host limiter, not one process worth of memory', () => {
    const seen: AuthRateLimitPolicy[] = [];
    configureAuthLimiters((policy) => {
      seen.push(policy);
      return tableLimiter(policy, 0);
    });

    const auth = defineAuth({ adapter: adapter() });

    // Without the seam this reads `'process'` — one pod's worth of lockout under a chart that
    // ships three replicas, which is the whole defect.
    expect(auth.limiter.policy.scope).toBe('shared');
    // BOTH buckets, and each with its OWN policy: the account/IP bucket counts to `maxAttempts`
    // and the tenant bucket to `orgMaxAttempts`, over keys that cannot collide.
    expect(seen.map((policy) => policy.maxAttempts)).toEqual([5, 100]);
  });

  test('the factory is handed the RESOLVED policy, so a tuned app still boots', () => {
    configureAuthLimiters((policy) => tableLimiter(policy, 0));
    // A limiter built from the framework default would report `maxAttempts: 5` here and
    // `assertAuthLimiterPolicy` would refuse it — the failure a boot-built limiter cannot avoid.
    const auth = defineAuth({ adapter: adapter(), rateLimit: { maxAttempts: 3, scope: 'shared' } });
    expect(auth.limiter.policy.maxAttempts).toBe(3);
  });

  test('a factory that ignores the policy it was handed is still refused', () => {
    const wrong: AuthRateLimitPolicy = {
      maxAttempts: 5,
      windowMs: 1,
      lockoutMs: 1,
      scope: 'shared',
    };
    configureAuthLimiters(() => tableLimiter(wrong, 0));
    expect(codeOf(() => defineAuth({ adapter: adapter(), rateLimit: { maxAttempts: 3 } }))).toBe(
      'X_AUTH_LIMITER_POLICY_MISMATCH',
    );
  });

  test('and refused for the TENANT bucket, not only the general one', () => {
    // Honours the general policy and ignores the tenant one, so this refusal can only come from
    // the second comparison. Until it ran, the installed org limiter enforced whatever the host
    // built while `Auth.orgRateLimit` reported what the app declared — one factory, refused for
    // one bucket and trusted for the other.
    configureAuthLimiters((policy) =>
      tableLimiter(policy.maxAttempts === 100 ? { ...policy, maxAttempts: 5 } : policy, 0),
    );
    expect(codeOf(() => defineAuth({ adapter: adapter() }))).toBe('X_AUTH_LIMITER_POLICY_MISMATCH');
  });

  test('the LOCAL fallback is the one arm the tenant bucket still exempts', () => {
    // A shared LOCKOUT with no factory installed: the tenant bucket falls back to
    // `createAuthLimiter`, which always reports `'process'`. Comparing that arm would refuse an
    // app whose only claim is about the lockout — a per-replica `orgMaxAttempts` is a throughput
    // ceiling and discloses nothing — so the exemption is the fallback's, never a supplied
    // limiter's.
    const shared: AuthRateLimitPolicy = { ...DEFAULT_AUTH_RATE_LIMIT, scope: 'shared' };
    const auth = defineAuth({
      adapter: adapter(),
      rateLimit: { scope: 'shared' },
      limiter: tableLimiter(shared, 0),
    });
    expect(auth.orgLimiter.policy.scope).toBe('process');
  });

  test('an explicitly passed limiter still wins over the installed factory', () => {
    let calls = 0;
    configureAuthLimiters((policy) => {
      calls += 1;
      return tableLimiter(policy, 0);
    });
    const mine = createAuthLimiter({ now: () => new Date(0), monotonic: () => 0 });
    const auth = defineAuth({ adapter: adapter(), limiter: mine });
    expect(auth.limiter).toBe(mine);
    // The tenant bucket was NOT passed, so the factory still built that one and only that one.
    expect(calls).toBe(1);
  });

  test('resetAuthLimiters puts the per-process default back', () => {
    configureAuthLimiters((policy) => tableLimiter(policy, 0));
    resetAuthLimiters();
    expect(defineAuth({ adapter: adapter() }).limiter.policy.scope).toBe('process');
  });
});

describe('purgeAuthLimits', () => {
  test('answers 0 when no host installed anything', async () => {
    expect(await purgeAuthLimits()).toBe(0);
  });

  test('skips a limiter that bounds itself', async () => {
    configureAuthLimiters((policy) =>
      createAuthLimiter({ now: () => new Date(0), monotonic: () => 0 }, policy),
    );
    defineAuth({ adapter: adapter() });
    expect(await purgeAuthLimits()).toBe(0);
  });

  test('sweeps only the WIDEST window, never the narrow one beside it', async () => {
    const built: (AuthLimiter & { readonly sweeps: () => number })[] = [];
    configureAuthLimiters((policy) => {
      const limiter = tableLimiter(policy, rowsFor(policy.windowMs));
      built.push(limiter);
      return limiter;
    });
    // The framework default is a 15-minute window, which is the wide one here. Declared FIRST, so
    // "sweep the last one built" and "sweep the widest" are different answers: the narrow limiter
    // below is the most recent, and it is the one that must not run.
    defineAuth({ adapter: adapter() });
    defineAuth({ adapter: adapter(), rateLimit: { windowMs: 60_000, lockoutMs: 60_000 } });
    defineAuth({ adapter: adapter(), rateLimit: { windowMs: 1_800_000 } });

    // 11, and neither 7 (the first built) nor 3 (the last): every limiter here writes the same two tables, so sweeping a narrower
    // window would delete failures a wider one is still counting — a sprayer buying attempts back
    // from the cleanup job. One sweep, by the widest.
    expect(await purgeAuthLimits()).toBe(11);
    expect(built.filter((limiter) => limiter.sweeps() > 0)).toHaveLength(1);
    expect(built.at(-1)?.sweeps()).toBe(0);
  });

  // What a purge can REACH is one limiter per window, and never one per `defineAuth`. The list
  // this replaced was appended to on every call and trimmed by nothing, so a process that redefines
  // auth — `x dev`'s reload, a test file, a multi-tenant host building one `Auth` per app — held
  // two more limiters, and the two stores behind them, for its whole life. `purgeAuthLimits`
  // sweeps exactly ONE of them however many were retained, so nothing about behaviour could see
  // the growth: this counter is the only observation there is.
  test('what is retained is one limiter per window, not one per defineAuth', () => {
    configureAuthLimiters((policy) => tableLimiter(policy, 0));
    for (let boot = 0; boot < 50; boot += 1) defineAuth({ adapter: adapter() });

    // 100 limiters built — the account/IP bucket and the tenant bucket per call — over ONE window,
    // since `orgRateLimit` changes `maxAttempts` and nothing else. Observed before the fix: 100.
    expect(installedLimiterCount()).toBe(1);
  });

  test('a distinct window is still kept, or the widest could not be found', async () => {
    configureAuthLimiters((policy) => tableLimiter(policy, rowsFor(policy.windowMs)));
    defineAuth({ adapter: adapter() });
    defineAuth({ adapter: adapter(), rateLimit: { windowMs: 1_800_000 } });

    expect(installedLimiterCount()).toBe(2);
    expect(await purgeAuthLimits()).toBe(11);
  });

  test('a second install forgets what the first built', async () => {
    // Every limiter the first factory built is REACHABLE here — the collector holds the same
    // instances the factory returned. Returning a second, different limiter made both assertions
    // below hold whether or not `configureAuthLimiters` released the previous pool.
    const first: (AuthLimiter & { readonly sweeps: () => number })[] = [];
    configureAuthLimiters((policy) => {
      const limiter = tableLimiter(policy, 4);
      first.push(limiter);
      return limiter;
    });
    defineAuth({ adapter: adapter() });
    // The next boot's pool is a different pool; a purge through the closed one is not a sweep.
    configureAuthLimiters((policy) => tableLimiter(policy, 0));
    expect(await purgeAuthLimits()).toBe(0);
    expect(first.filter((limiter) => limiter.sweeps() > 0)).toEqual([]);
  });
});
