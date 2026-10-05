// Single responsibility: the `health` and `drain` sections of `app.config.ts` — what `/readyz`
// means and how a SIGTERM'd process leaves the load balancer — and the domain of the readiness
// mode, so the config validator and `configureLifecycle` refuse the same values.

import { UltimateError } from './errors';

/**
 * `'dependencies'` (the default): `/readyz` is 503 while starting, draining, or while ANY registered
 * check fails. `'process'`: 503 only while starting or draining — a failing check is REPORTED in the
 * body (`checks.database: 'failing'`) and the status stays 200.
 *
 * Why the second exists: every replica shares the dependency, so one database blip marks the WHOLE
 * fleet unready at once and the ingress answers "no available server" for every URL — pages that
 * never touch the database included — where the app itself would have served them, or answered its
 * own 503 for the ones that do. `/readyz?deep=1` always answers in `'dependencies'` mode, so
 * monitoring still sees the dependency fail.
 */
export type ReadinessMode = 'dependencies' | 'process';

export const READINESS_MODES: readonly ReadinessMode[] = ['dependencies', 'process'];

/** `app.config.ts`'s `health` section. Read by the production boot into `configureLifecycle`. */
export interface HealthConfig {
  readonly readiness: ReadinessMode;
}

/**
 * How a SIGTERM'd process leaves the load balancer. Read by `@ultimat3/http`'s `createServer`
 * (`ServerOptions.drain`), which hands it to core's `configureLifecycle`.
 */
export interface DrainConfig {
  /**
   * `/readyz` answers 503 for this long before the listener closes, so endpoints stop routing here
   * first. Default 0 in development/test and 5000 everywhere else — a process naming NO environment
   * included. A whole number, 0–60000. The chart's `terminationGracePeriodSeconds` must exceed it
   * plus `deadlineMs`.
   */
  readonly readinessGraceMs: number;
  /**
   * The drain budget: how long a SIGTERM'd process has to finish what it holds — in-flight requests,
   * a running job — after the grace, before the lifecycle abandons the rest. Applied to EVERY role,
   * so this is the knob that gives a long job room to finish on a deploy. Default 25000. A whole
   * number, 1–3600000. `http.drainTimeoutMs`, when an app declares it, still wins on the web role.
   */
  readonly deadlineMs: number;
}

/** Why a value is not a readiness mode, or `undefined` when it is one. */
export function readinessModeIssue(value: unknown): string | undefined {
  if (READINESS_MODES.some((mode) => mode === value)) return undefined;
  const said = typeof value === 'string' ? `"${value}"` : typeof value;
  return `health.readiness ${said} is not one of ${READINESS_MODES.join(', ')}`;
}

/** `configureLifecycle`'s screen: the mode, or `X_CONFIG_INVALID` naming the key. */
export function assertReadinessMode(value: unknown): ReadinessMode {
  const issue = readinessModeIssue(value);
  if (issue === undefined) return value as ReadinessMode;
  throw new UltimateError({
    code: 'X_CONFIG_INVALID',
    cause: issue,
    fix: "set health: { readiness: 'process' } (or 'dependencies', the default) in app.config.ts",
    meta: { key: 'health.readiness' },
  });
}
