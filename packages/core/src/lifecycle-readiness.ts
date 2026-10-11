// Single responsibility: the readiness CHECK — its signature, its two answers, and the registry of
// named checks `/readyz` runs. The mode that decides what a failing one does to `/readyz` is
// `config-health.ts`'s; the lifecycle that reports through them is `lifecycle.ts`.

import { UltimateError } from './errors';

/**
 * `'degraded'` is a failed check the role serves WITHOUT (`onFailure: 'degraded'`): reported by
 * name, never a 503 on `/readyz` in either mode, and a 503 on `/readyz?deep=1` — the probe routes
 * traffic on the first and a monitor alerts on the second.
 */
export type ReadinessStatus = 'ok' | 'degraded' | 'failing';

export interface ReadinessCheckOptions {
  /**
   * What a `false` (or a throw) from this check is. `'failing'`, the default, is a dependency the
   * role cannot serve without. `'degraded'` is one it can — the bus of a role that only publishes
   * to it: pulling every replica from the ingress for a dependency no served request waits on is
   * the outage the probe exists to prevent.
   */
  readonly onFailure?: 'failing' | 'degraded' | undefined;
}

/**
 * Synchronous, and that is the design, not a limitation. **Do not widen this to
 * `() => Promise<boolean>`** — the signature is the mechanism.
 *
 * A readiness endpoint that does I/O is a liveness bomb. A probe that awaits a network call takes
 * as long as the dependency does, so a slow database makes the endpoint miss its `timeoutSeconds`,
 * the kubelet reads that as unready, and capacity is pulled from an already-struggling system —
 * the outage the probe existed to prevent, caused by the probe. Worse under a liveness probe
 * sharing the handler: the pod is killed and restarts into the same slow database, cold.
 *
 * So the owner of the dependency keeps a boolean fresh — a pool exposes `isOpen`, a background
 * poller flips a flag on its own schedule with its own timeout — and this reads it. That puts the
 * waiting where a timeout can be tuned, and leaves this path unable to block. A check that throws
 * is `failing`.
 */
export type ReadinessCheck = () => boolean;

interface Registered {
  readonly check: ReadinessCheck;
  readonly onFailure: 'failing' | 'degraded';
}

const checks = new Map<string, Registered>();

/**
 * Register a named readiness check. Returns its unregister — the same shape as `onShutdown`, and
 * owned by whoever can be started twice, for the same reason.
 */
export function registerReadinessCheck(
  name: string,
  check: ReadinessCheck,
  options: ReadinessCheckOptions = {},
): () => void {
  if (checks.has(name)) {
    throw new UltimateError({
      code: 'X_READINESS_CHECK_DUPLICATE',
      cause: `a readiness check named "${name}" is already registered (have: ${[...checks.keys()].join(', ')})`,
      fix: `name the second check for what it actually probes, e.g. registerReadinessCheck('${name}-replica', check) — or hold the unregister the first registration returned and call it first`,
      meta: { name },
    });
  }
  const registered: Registered = { check, onFailure: options.onFailure ?? 'failing' };
  checks.set(name, registered);
  return () => {
    if (checks.get(name) === registered) checks.delete(name);
  };
}

/** Test-only: registered checks. A count that climbs across a start/stop cycle is a leak. */
export function readinessCheckCount(): number {
  return checks.size;
}

/** Drop every check — `resetLifecycle()`'s, and nothing else's. */
export function clearReadinessChecks(): void {
  checks.clear();
}

/**
 * Every check, run now, by name. A check that throws is its `onFailure` (`failing` unless it was
 * registered degradable) — never an unhandled error — and is handed to `onThrow`, which `lifecycle.ts` routes through its total `report`.
 *
 * Built through `Object.fromEntries`, never by assigning `results[name]`: assignment to the one
 * name `__proto__` sets the PROTOTYPE instead of adding a key, so that check vanished from the
 * report, `ready` was computed over an empty object — vacuously true — and a failing check
 * answered 200. `fromEntries` defines own properties and has no such name.
 */
export function runReadinessChecks(
  onThrow: (name: string, thrown: unknown) => void,
): Readonly<Record<string, ReadinessStatus>> {
  const results: [string, ReadinessStatus][] = [];
  for (const [name, { check, onFailure }] of checks) {
    try {
      results.push([name, check() ? 'ok' : onFailure]);
    } catch (thrown) {
      results.push([name, onFailure]);
      onThrow(name, thrown);
    }
  }
  return Object.fromEntries(results);
}
