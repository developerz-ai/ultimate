// Single responsibility: the readiness grace's default and its domain. One module because the
// config validator and `configureLifecycle` must refuse the same values and default the same way.

import { countIssue } from './config-count';
import { tryResolveEnvironment } from './environment';

/**
 * Outside a local environment. Long enough for the endpoints controller to observe `/readyz` at
 * 503 and for kube-proxy/the ingress to stop routing here (`periodSeconds: 5` in the shipped chart
 * is the dominant term); short enough to sit well inside a 30s `terminationGracePeriodSeconds`
 * beside the 25s drain budget it is ADDED to.
 */
export const READINESS_GRACE_DEFAULT_MS = 5000;

/** A grace past a minute is a stalled rollout, not a drain. */
export const READINESS_GRACE_MAX_MS = 60_000;

type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * `0` in `development`/`test`, where no load balancer is routing and a Ctrl-C should be instant;
 * the full grace everywhere else. FAILS CLOSED: a process naming no environment — or a
 * `ULTIMATE_ENV` that is not one — is production here, because the process that forgot to say is
 * exactly the one a 502 on every deploy would reach.
 */
export function defaultReadinessGraceMs(env?: EnvRecord): number {
  const environment = tryResolveEnvironment({ env, fallback: 'production' });
  return environment === 'development' || environment === 'test' ? 0 : READINESS_GRACE_DEFAULT_MS;
}

/**
 * Why a value is not a grace, or `undefined` when it is one. A whole number of milliseconds in
 * `0 ≤ v ≤ 60000`; a fraction is refused rather than rounded, since `setTimeout` would round it
 * and nothing would say so.
 */
export function readinessGraceIssue(value: unknown): string | undefined {
  const count = countIssue(GRACE_KEY, value, 0);
  if (count !== undefined) return count;
  return (value as number) > READINESS_GRACE_MAX_MS
    ? `${GRACE_KEY} must be at most ${READINESS_GRACE_MAX_MS} milliseconds — a longer grace is a stalled rollout, not a drain`
    : undefined;
}

const GRACE_KEY = 'drain.readinessGraceMs';
