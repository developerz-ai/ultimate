// Single responsibility: the lifecycle's data model — its states, phases, hook and option shapes,
// and the health report it answers with. The mechanism that moves between them is `lifecycle.ts`,
// which re-exports every name here so a caller keeps one import path.

import type { Clock } from './clock';
import type { ReadinessMode } from './config-health';
import type { ReadinessStatus } from './lifecycle-readiness';
import type { Logger } from './logger';

export type HealthState = 'starting' | 'ready' | 'draining' | 'stopped';

/** Ordered. `accept` runs first, `close` last. */
export type ShutdownPhase = 'accept' | 'inflight' | 'close';

export const SHUTDOWN_PHASES: readonly ShutdownPhase[] = ['accept', 'inflight', 'close'];

/** Signals Ultimate reacts to. Narrower than `NodeJS.Signals` on purpose. */
export type ProcessSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT';

export interface ShutdownReason {
  readonly signal: string;
  /**
   * Real monotonic ms (`systemClock`) after which hooks are abandoned — deliberately NOT the
   * injected clock. The budget this bounds is `terminationGracePeriodSeconds`, counted by the
   * kubelet in real seconds, so a frozen clock must be unable to extend it: read off `clock` a
   * test that advanced an hour of fake time handed the drain a 16-minute grace period, while
   * `waitForIdle` went on sleeping on a real `setTimeout`. `clock` still owns `uptimeMs`.
   */
  readonly deadlineAt: number;
}

export type ShutdownHook = (reason: ShutdownReason) => void | Promise<void>;

export interface OnShutdownOptions {
  readonly phase?: ShutdownPhase | undefined;
}

export interface LifecycleOptions {
  /**
   * The whole drain's budget — the in-flight wait AND every hook, in every phase. 25s by default,
   * and **enforced whether or not an app sets it**: `ShutdownReason.deadlineAt` was always computed
   * and handed to every hook, so the deadline was declared by the design and only the enforcement
   * was missing. No hook reads `deadlineAt`, which is why it has to be imposed here.
   *
   * The lever is a LARGER value, not the absence of one: a `worker` holding a 10-minute job wants
   * `configureLifecycle({ deadlineMs: 600_000 })` and a `terminationGracePeriodSeconds` at least as
   * large. Left at 25s it is abandoned and the process exits clean — the row's visibility lease
   * lapses and another worker re-claims it, which is what at-least-once already promises. The
   * alternative is not "the job finishes": it is the same duplicate, delivered by SIGKILL at the
   * kubelet's grace period, with no log line naming what overran.
   *
   * Screened where it is assigned: a whole number of milliseconds, 0 or more. `0` is "drain now".
   */
  readonly deadlineMs?: number | undefined;
  /**
   * How long `/readyz` answers 503 BEFORE the `accept` phase closes the listener — the time the
   * endpoints controller and the ingress need to stop routing here. Closing on the flip itself left
   * endpoints pointing at a closed socket, and a POST in that window got a 502. Added to
   * `deadlineMs`, never taken from it. Unset: `defaultReadinessGraceMs()` of the process env at
   * drain time — 0 in development/test, 5000 everywhere else, including a process naming no env.
   * A whole number from 0 to 60000; 0 is no grace.
   */
  readonly readinessGraceMs?: number | undefined;
  /** What a failing check does to `/readyz` — see `ReadinessMode`. Default `'dependencies'`. */
  readonly readiness?: ReadinessMode | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
}

export interface HealthReport {
  readonly state: HealthState;
  readonly ready: boolean;
  readonly uptimeMs: number;
  readonly inflight: number;
  readonly buildId: string;
  /** Named, because "alert on check failures BY CHECK NAME" is not writable against a boolean. */
  readonly checks: Readonly<Record<string, ReadinessStatus>>;
  /**
   * How many checks are registered. `checks: {}` reads identically for "every check passed" and
   * "nobody registered one", and only the second is a `/readyz` that means no more than "the
   * socket is bound" — which is what the chart's and compose's healthchecks route traffic on.
   * Reported rather than enforced: an empty registry is still ready, so a role that genuinely has
   * no dependency does not have to invent a check to boot.
   */
  readonly registered: number;
}

export interface HealthPayload {
  readonly ok: boolean;
  /** The status code the HTTP layer should return. Core stays HTTP-free; this is just data. */
  readonly status: number;
  readonly body: HealthReport;
}
