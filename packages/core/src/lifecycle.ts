// Single responsibility: process lifecycle and graceful drain. Every role runs the same three
// phases on SIGTERM — stop accepting, finish in-flight, close resources — under one deadline,
// and reports the same /healthz + /readyz state.

import { type Clock, systemClock } from './clock';
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

export interface HealthReport {
  readonly state: HealthState;
  readonly ready: boolean;
  readonly uptimeMs: number;
  readonly inflight: number;
  readonly buildId: string;
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

export function markReady(): void {
  if (state === 'starting') state = 'ready';
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
  return {
    state,
    ready: state === 'ready',
    uptimeMs: Math.round(clock.monotonic() - startedAtMono),
    inflight,
    buildId: process.env['BUILD_ID'] ?? 'dev',
  };
}

/** Liveness: the process exists and is not wedged. Stays 200 while draining. */
export function healthzPayload(): HealthPayload {
  const body = healthReport();
  const ok = state !== 'stopped';
  return { ok, status: ok ? 200 : 503, body };
}

/** Readiness: may this instance receive traffic? 503 while starting or draining. */
export function readyzPayload(): HealthPayload {
  const body = healthReport();
  const ok = state === 'ready';
  return { ok, status: ok ? 200 : 503, body };
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
}
