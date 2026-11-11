// Single responsibility: the credential ports an `Auth` reads — the two limiters and the TOTP
// replay guard — resolved where they are USED, never captured when `defineAuth` runs. What
// `defineAuth` was PASSED always wins.
//
// Why: the boot installs them after `runtime.ts` loads, and anything `runtime.ts` imports may call
// `defineAuth` first: captured, that app kept per-pod memory guards for life (lockouts × replicas,
// a TOTP code or SAML assertion replayable on every other pod).

import type { Clock } from '@ultimat3/core';
import { totpReplayGuardInvalid } from './errors';
import {
  authLimiterInstall,
  installedAuthLimiter,
  installedTotpReplay,
  totpReplayInstall,
} from './limiter-install';
import { memoryTotpReplayGuard, type TotpReplayGuard } from './mfa';
import {
  type AuthLimiter,
  type AuthRateLimitPolicy,
  assertAuthLimiterPolicy,
  memoryAuthLimiter,
} from './rate-limit';

/**
 * The installed port, rebuilt only when the install changes; else `fallback`, built once. `check`
 * runs on every port built, so a mismatch is refused where it first appears.
 */
function resolving<F, P>(
  installed: () => F | undefined,
  build: () => P | undefined,
  fallback: () => P,
): () => P {
  let from: F | undefined;
  let port: P | undefined;
  let local: P | undefined;
  return () => {
    const current = installed();
    if (current === undefined) {
      local ??= fallback();
      return local;
    }
    if (current !== from || port === undefined) {
      port = build() ?? fallback();
      from = current;
    }
    return port;
  };
}

/** A limiter for `policy`: passed, else installed, else this process' memory. `exempt`: the fallback is not compared. */
export function limiterPort(
  passed: AuthLimiter | undefined,
  policy: AuthRateLimitPolicy,
  clock: Clock,
  exempt: boolean,
): () => AuthLimiter {
  if (passed !== undefined) {
    assertAuthLimiterPolicy(policy, passed);
    return () => passed;
  }
  const checked = (limiter: AuthLimiter): AuthLimiter => {
    assertAuthLimiterPolicy(policy, limiter);
    return limiter;
  };
  const read = resolving(
    authLimiterInstall,
    () => {
      const built = installedAuthLimiter(policy);
      return built === undefined ? undefined : checked(built);
    },
    () => (exempt ? memoryAuthLimiter(clock, policy) : checked(memoryAuthLimiter(clock, policy))),
  );
  // Installed already: built and judged now, so a factory that ignores the policy is refused at
  // `defineAuth` as before. Not installed: judged at first use, after the boot had its chance.
  if (authLimiterInstall() !== undefined) read();
  return read;
}

const validGuard = (guard: TotpReplayGuard): TotpReplayGuard => {
  // Unreachable from TypeScript and reachable from a guard written before `claim`, which would
  // otherwise be found at the first second factor, as a TypeError, on a production sign-in.
  const declared: { readonly claim?: unknown } = guard;
  if (typeof declared.claim !== 'function') throw totpReplayGuardInvalid();
  return guard;
};

/** Where spent TOTP steps (and SAML assertions) are claimed: passed, else installed, else memory. */
export function totpReplayPort(passed: TotpReplayGuard | undefined): () => TotpReplayGuard {
  if (passed !== undefined) {
    const guard = validGuard(passed);
    return () => guard;
  }
  const read = resolving(
    totpReplayInstall,
    () => {
      const built = installedTotpReplay();
      return built === undefined ? undefined : validGuard(built);
    },
    memoryTotpReplayGuard,
  );
  if (totpReplayInstall() !== undefined) read();
  return read;
}
