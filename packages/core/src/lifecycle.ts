// Single responsibility: process lifecycle and graceful drain. Every role runs the same three
// phases on SIGTERM — stop accepting, finish in-flight, close resources — under one deadline,
// and reports the same /healthz + /readyz state.

import { type Clock, systemClock } from './clock';
import { UltimateError } from './errors';
import { settleWithin } from './lifecycle-deadline';
import { type Logger, logger as rootLogger } from './logger';

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
   */
  readonly deadlineMs?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
}

export type ReadinessStatus = 'ok' | 'failing';

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

export interface HealthReport {
  readonly state: HealthState;
  readonly ready: boolean;
  readonly uptimeMs: number;
  readonly inflight: number;
  readonly buildId: string;
  /** Named, because "alert on check failures BY CHECK NAME" is not writable against a boolean. */
  readonly checks: Readonly<Record<string, ReadinessStatus>>;
}

export interface HealthPayload {
  readonly ok: boolean;
  /** The status code the HTTP layer should return. Core stays HTTP-free; this is just data. */
  readonly status: number;
  readonly body: HealthReport;
}

interface Registration {
  readonly name: string;
  readonly phase: ShutdownPhase;
  readonly hook: ShutdownHook;
}

const DEFAULT_DEADLINE_MS = 25_000;

let deadlineMs = DEFAULT_DEADLINE_MS;
let clock: Clock = systemClock;
let log: Logger = rootLogger;
let state: HealthState = 'starting';
let startedAtMono = clock.monotonic();
let inflight = 0;
let registrations: Registration[] = [];
let drainPromise: Promise<void> | undefined;
let idleWaiters: (() => void)[] = [];
const readiness = new Map<string, ReadinessCheck>();

export function configureLifecycle(options: LifecycleOptions): void {
  if (options.deadlineMs !== undefined) deadlineMs = options.deadlineMs;
  if (options.clock !== undefined) {
    clock = options.clock;
    startedAtMono = clock.monotonic();
  }
  if (options.logger !== undefined) log = options.logger;
}

export function lifecycleState(): HealthState {
  return state;
}

/**
 * "This process bound its socket." NOT "this process can serve a request" — that is what the
 * readiness checks answer. Before them, `markReady()` was the whole of `/readyz`, so a pod went
 * green the instant it bound and the load balancer sent traffic into a Postgres pool that had not
 * opened a connection yet; `maxUnavailable: 0` does not help when readiness lies.
 */
export function markReady(): void {
  if (state === 'starting') state = 'ready';
}

/**
 * Register a named readiness check. Returns its unregister — the same shape as `onShutdown`, and
 * owned by whoever can be started twice, for the same reason.
 */
export function registerReadinessCheck(name: string, check: ReadinessCheck): () => void {
  if (readiness.has(name)) {
    throw new UltimateError({
      code: 'X_READINESS_CHECK_DUPLICATE',
      cause: `a readiness check named "${name}" is already registered (have: ${[...readiness.keys()].join(', ')})`,
      fix: `name the second check for what it actually probes, e.g. registerReadinessCheck('${name}-replica', check) — or hold the unregister the first registration returned and call it first`,
      meta: { name },
    });
  }
  readiness.set(name, check);
  return () => {
    if (readiness.get(name) === check) readiness.delete(name);
  };
}

/** Test-only: registered checks. A count that climbs across a start/stop cycle is a leak. */
export function readinessCheckCount(): number {
  return readiness.size;
}

/** Every check, run now, by name. A check that throws is `failing` — never an unhandled error. */
export function readinessChecks(): Readonly<Record<string, ReadinessStatus>> {
  const results: Record<string, ReadinessStatus> = {};
  for (const [name, check] of readiness) {
    try {
      results[name] = check() ? 'ok' : 'failing';
    } catch (thrown) {
      results[name] = 'failing';
      log.warn('readiness check threw', { check: name, error: thrown });
    }
  }
  return results;
}

export function inflightCount(): number {
  return inflight;
}

/** Test-only: drains still waiting on in-flight work. A count stuck above zero is a leak. */
export function idleWaiterCount(): number {
  return idleWaiters.length;
}

/**
 * Test-only: hooks still registered. A count that climbs across a start/stop cycle is a leak —
 * the registration retains its closure, and the next drain runs it against a torn-down resource.
 */
export function shutdownHookCount(): number {
  return registrations.length;
}

/** Register a drain hook. Returns an unregister function. */
export function onShutdown(
  name: string,
  hook: ShutdownHook,
  options?: OnShutdownOptions,
): () => void {
  const registration: Registration = { name, phase: options?.phase ?? 'close', hook };
  registrations.push(registration);
  return () => {
    registrations = registrations.filter((candidate) => candidate !== registration);
  };
}

/**
 * Mark a unit of work in flight. Call the returned function when it completes — drain waits
 * for the count to reach zero before closing resources.
 */
export function beginWork(): () => void {
  inflight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inflight -= 1;
    if (inflight === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const waiter of waiters) waiter();
    }
  };
}

/** True when new work must be refused — the HTTP layer answers 503 while this holds. */
export function isDraining(): boolean {
  return state === 'draining' || state === 'stopped';
}

function waitForIdle(timeoutMs: number): Promise<boolean> {
  if (inflight === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const waiter = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    // A drain that times out must not leave its waiter in the queue forever — the next
    // `beginWork()` to reach zero would still hold and invoke it, a dangling closure over a
    // promise nothing is awaiting anymore.
    const timer = setTimeout(() => {
      idleWaiters = idleWaiters.filter((candidate) => candidate !== waiter);
      resolve(false);
    }, timeoutMs);
    idleWaiters.push(waiter);
  });
}

/**
 * The budget every drain is bounded by — `DEFAULT_DEADLINE_MS` until an app raises it. There is no
 * unbounded state: `ShutdownReason.deadlineAt` was always computed and handed to every hook, so the
 * deadline was declared by the design all along and only the enforcement was missing.
 *
 * The ONE place the budget is decided, and exported so a test can pin it: 25s is far above any
 * drain a test can wait out, so the default needs a probe and not only a stopwatch.
 */
export function drainDeadlineMs(): number {
  return deadlineMs;
}

/**
 * What is left of that budget. Read per hook, not per phase: the deadline bounds the WHOLE drain,
 * so a hook that spent it leaves nothing for the ones behind it — which is what
 * `terminationGracePeriodSeconds` means, and what makes the SUM of the phases bounded rather than
 * each one of them separately. Returns `number`, never `number | undefined`: "no budget" is not a
 * state this file has, and the type is what keeps it from becoming one again.
 */
function remainingBudget(reason: ShutdownReason): number {
  return Math.max(0, reason.deadlineAt - systemClock.monotonic());
}

async function runPhase(phase: ShutdownPhase, reason: ShutdownReason): Promise<void> {
  for (const registration of registrations.filter((entry) => entry.phase === phase)) {
    const outcome = await settleWithin(() => registration.hook(reason), remainingBudget(reason));
    if (outcome.kind === 'failed') {
      log.error('shutdown hook failed', {
        hook: registration.name,
        phase,
        error: outcome.error,
      });
      continue;
    }
    if (outcome.kind === 'abandoned') {
      // Abandoned, not merely logged. A deadline that waited anyway would leave the kubelet to
      // SIGKILL this process — the every-deploy duplicate that draining exists to prevent — so
      // the drain moves on and the hook is left running with nobody reading it. The cost of that
      // choice is real and named in the cause: a write it had in flight may be half done.
      log.warn('X_SHUTDOWN_TIMEOUT', {
        code: 'X_SHUTDOWN_TIMEOUT',
        cause: `the "${registration.name}" shutdown hook (phase: ${phase}) was still running at the ${deadlineMs}ms drain deadline and has been ABANDONED — the process exits without it, so anything it had in flight may be incomplete`,
        fix: `raise the budget past the work this hook does — configureLifecycle({ deadlineMs: 600_000 }) for a 10-minute job — and set terminationGracePeriodSeconds to at least as many seconds, or make the "${registration.name}" hook return once it has stopped accepting work rather than once it has finished`,
        hook: registration.name,
        phase,
      });
    }
  }
}

/** Idempotent: concurrent signals join the same drain. */
export function drain(signal = 'manual'): Promise<void> {
  if (drainPromise !== undefined) return drainPromise;
  state = 'draining';
  const reason: ShutdownReason = { signal, deadlineAt: systemClock.monotonic() + deadlineMs };

  drainPromise = (async () => {
    log.info('draining', { signal, deadlineMs, inflight });
    await runPhase('accept', reason);

    // Real monotonic, like `deadlineAt` itself: `waitForIdle` sleeps on a real `setTimeout`, and a
    // budget read off an injected clock is a number that timer will never honour.
    const remaining = Math.max(0, reason.deadlineAt - systemClock.monotonic());
    const idle = await waitForIdle(remaining);
    if (!idle) {
      log.warn('X_SHUTDOWN_TIMEOUT', {
        code: 'X_SHUTDOWN_TIMEOUT',
        cause: `${inflight} in-flight operations still running after ${deadlineMs}ms`,
        fix: 'raise the budget past the slowest handler — configureLifecycle({ deadlineMs: 600_000 }) for a 10-minute one — and set terminationGracePeriodSeconds to at least as many seconds, or shorten the handler',
      });
    }

    await runPhase('inflight', reason);
    await runPhase('close', reason);
    state = 'stopped';
    log.info('stopped', { signal });
  })();

  return drainPromise;
}

export interface SignalHandlerOptions {
  readonly signals?: readonly ProcessSignal[] | undefined;
  /** Call `process.exit()` once drained. Off in tests. */
  readonly exit?: boolean | undefined;
}

/** Install SIGTERM/SIGINT handling. Returns an uninstall function. */
export function installSignalHandlers(options?: SignalHandlerOptions): () => void {
  const signals: readonly ProcessSignal[] = options?.signals ?? ['SIGTERM', 'SIGINT'];
  const handlers = new Map<ProcessSignal, () => void>();

  for (const signal of signals) {
    const handler = (): void => {
      void drain(signal).then(() => {
        if (options?.exit === true) process.exit(0);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export function healthReport(): HealthReport {
  const checks = readinessChecks();
  return {
    state,
    // `ready` is the same predicate `/readyz` answers on, so a body and its status can never
    // disagree — a 200 whose body says `ready: false` is the bug this shares one source to avoid.
    ready: state === 'ready' && Object.values(checks).every((status) => status === 'ok'),
    uptimeMs: Math.round(clock.monotonic() - startedAtMono),
    inflight,
    buildId: process.env['BUILD_ID'] ?? 'dev',
    checks,
  };
}

/**
 * Liveness: the process exists and is not wedged. Stays 200 while draining, and deliberately
 * ignores the checks — a database outage that failed liveness everywhere would restart the whole
 * fleet into the same outage, with cold caches and no connections.
 */
export function healthzPayload(): HealthPayload {
  const body = healthReport();
  const ok = state !== 'stopped';
  return { ok, status: ok ? 200 : 503, body };
}

/** Readiness: may this instance receive traffic? 503 while starting, draining or any check fails. */
export function readyzPayload(): HealthPayload {
  const body = healthReport();
  return { ok: body.ready, status: body.ready ? 200 : 503, body };
}

/** Test-only: forget all hooks and return to `starting`. */
export function resetLifecycle(): void {
  deadlineMs = DEFAULT_DEADLINE_MS;
  clock = systemClock;
  log = rootLogger;
  state = 'starting';
  startedAtMono = clock.monotonic();
  inflight = 0;
  registrations = [];
  drainPromise = undefined;
  idleWaiters = [];
  readiness.clear();
}
