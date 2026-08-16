// Single responsibility: process lifecycle and graceful drain. Every role runs the same three
// phases on SIGTERM — stop accepting, finish in-flight, close resources — under one deadline,
// and reports the same /healthz + /readyz state.

import { type Clock, systemClock } from './clock';
import { UltimateError } from './errors';
import { type Logger, logger as rootLogger } from './logger';

export type HealthState = 'starting' | 'ready' | 'draining' | 'stopped';

/** Ordered. `accept` runs first, `close` last. */
export type ShutdownPhase = 'accept' | 'inflight' | 'close';

export const SHUTDOWN_PHASES: readonly ShutdownPhase[] = ['accept', 'inflight', 'close'];

/** Signals Ultimate reacts to. Narrower than `NodeJS.Signals` on purpose. */
export type ProcessSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT';

export interface ShutdownReason {
  readonly signal: string;
  /** Monotonic ms after which hooks are abandoned. */
  readonly deadlineAt: number;
}

export type ShutdownHook = (reason: ShutdownReason) => void | Promise<void>;

export interface OnShutdownOptions {
  readonly phase?: ShutdownPhase | undefined;
}

export interface LifecycleOptions {
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

async function runPhase(phase: ShutdownPhase, reason: ShutdownReason): Promise<void> {
  for (const registration of registrations.filter((entry) => entry.phase === phase)) {
    try {
      await registration.hook(reason);
    } catch (thrown) {
      log.error('shutdown hook failed', {
        hook: registration.name,
        phase,
        error: thrown,
      });
    }
  }
}

/** Idempotent: concurrent signals join the same drain. */
export function drain(signal = 'manual'): Promise<void> {
  if (drainPromise !== undefined) return drainPromise;
  state = 'draining';
  const reason: ShutdownReason = { signal, deadlineAt: clock.monotonic() + deadlineMs };

  drainPromise = (async () => {
    log.info('draining', { signal, deadlineMs, inflight });
    await runPhase('accept', reason);

    const remaining = Math.max(0, reason.deadlineAt - clock.monotonic());
    const idle = await waitForIdle(remaining);
    if (!idle) {
      log.warn('X_SHUTDOWN_TIMEOUT', {
        code: 'X_SHUTDOWN_TIMEOUT',
        cause: `${inflight} in-flight operations still running after ${deadlineMs}ms`,
        fix: 'raise configureLifecycle({ deadlineMs }) or shorten the slow handler',
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
