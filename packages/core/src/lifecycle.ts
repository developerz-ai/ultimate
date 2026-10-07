// Single responsibility: process lifecycle and graceful drain. Every role runs the same three
// phases on SIGTERM — stop accepting, finish in-flight, close resources — under one deadline,
// and reports the same /healthz + /readyz state.

import { type Clock, systemClock } from './clock';
import type { ReadinessMode } from './config-health';
import { assertReadinessMode } from './config-health';
import { DRAIN_DEADLINE_DEFAULT_MS } from './drain-deadline';
import { UltimateError } from './errors';
import { finiteCount } from './finite-option';
import { settleWithin } from './lifecycle-deadline';
import { lifecycleDrained } from './lifecycle-errors';
import { defaultReadinessGraceMs, readinessGraceIssue } from './lifecycle-grace';
import type { ReadinessStatus } from './lifecycle-readiness';
import {
  clearReadinessChecks,
  readinessCheckCount,
  runReadinessChecks,
} from './lifecycle-readiness';
import type {
  HealthPayload,
  HealthReport,
  HealthState,
  LifecycleOptions,
  OnShutdownOptions,
  ShutdownHook,
  ShutdownPhase,
  ShutdownReason,
} from './lifecycle-types';
import { type LogFields, type Logger, logger as rootLogger } from './logger';

// The data model and the readiness registry are modules of their own; every name stays exported
// from here, so nothing that imports a lifecycle type or the check registry learns a second path.
export { readinessCheckCount, registerReadinessCheck } from './lifecycle-readiness';
export type {
  HealthPayload,
  HealthReport,
  HealthState,
  LifecycleOptions,
  OnShutdownOptions,
  ProcessSignal,
  ShutdownHook,
  ShutdownPhase,
  ShutdownReason,
} from './lifecycle-types';
export { SHUTDOWN_PHASES } from './lifecycle-types';

interface Registration {
  readonly name: string;
  readonly phase: ShutdownPhase;
  readonly hook: ShutdownHook;
}

/** `drain.deadlineMs`'s default, owned by `drain-deadline.ts` so the config and this agree. */
const DEFAULT_DEADLINE_MS = DRAIN_DEADLINE_DEFAULT_MS;

let deadlineMs = DEFAULT_DEADLINE_MS;
/** `undefined` means "the environment's default", read when a drain starts, not at import. */
let graceMs: number | undefined;
let readinessMode: ReadinessMode = 'dependencies';
let clock: Clock = systemClock;
let log: Logger = rootLogger;
let state: HealthState = 'starting';
let startedAtMono = clock.monotonic();
let inflight = 0;
/** Bumped by `resetLifecycle()`: a `beginWork()` finisher only ever counts down its own lifetime. */
let lifetime = 0;
let registrations: Registration[] = [];
let drainPromise: Promise<void> | undefined;
let idleWaiters: (() => void)[] = [];

export function configureLifecycle(options: LifecycleOptions): void {
  // Screened above the write, never beside the arithmetic: `Math.max(0, deadlineAt - monotonic())`
  // PROPAGATES a NaN into `setTimeout(fn, NaN)`, i.e. 0 — measured, one in-flight operation dropped
  // and a 300ms close hook ABANDONED 111ms into a 25s budget, while `X_SHUTDOWN_TIMEOUT` rendered
  // `NaNms` and told the operator to RAISE a budget that was never a number. `min: 0` because 0 is
  // a real budget — drain now, no grace — and `drain.deadlineMs` reaches here unchanged.
  if (options.deadlineMs !== undefined) {
    deadlineMs = finiteCount('configureLifecycle', 'deadlineMs', options.deadlineMs, 0);
  }
  if (options.readinessGraceMs !== undefined) {
    const issue = readinessGraceIssue(options.readinessGraceMs);
    if (issue !== undefined) {
      throw new UltimateError({
        code: 'X_CONFIG_INVALID',
        cause: issue,
        fix: 'pass configureLifecycle({ readinessGraceMs: 5_000 }) — or set drain: { readinessGraceMs: 5_000 } in app.config.ts',
        meta: { key: 'drain.readinessGraceMs' },
      });
    }
    graceMs = options.readinessGraceMs;
  }
  if (options.readiness !== undefined) readinessMode = assertReadinessMode(options.readiness);
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
 *
 * **A drained lifecycle refuses this, and that is the whole of "one process, one lifecycle."**
 * `state` never leaves `stopped` and `drain()` memoizes, so a role that marked ready after a drain
 * used to be told nothing and go on to bind a socket answering 503 to everything, with no drain
 * left to close it. `X_LIFECYCLE_DRAINED` is that mistake named at the moment it is made, rather
 * than a lifecycle that can be restarted: two live lifecycles racing one shutdown is a worse
 * mechanism than a boot that fails.
 */
export function markReady(): void {
  if (isDraining()) throw lifecycleDrained(state === 'draining' ? 'draining' : 'stopped');
  if (state === 'starting') state = 'ready';
}

/**
 * Every line this file emits, and the only way it emits one. `log` is an injection seam
 * (`configureLifecycle({ logger })`), so an app's `Logger` decides whether a log call can throw —
 * and a throw here does not lose a line, it replaces the event. Inside `drain()` it rejected
 * `drainPromise`: `state` never reached 'stopped', the memo re-rejected for every later caller,
 * and on Bun the unhandled rejection ended the process the drain was trying to end cleanly.
 * Inside `readinessChecks()` it replaced the probe's answer with a throw.
 *
 * A lifecycle that cannot report is still a lifecycle: the line falls back to core's own
 * `rootLogger`, which is total by construction (`logger.ts`), and failing that is dropped.
 */
function report(level: 'info' | 'warn' | 'error', message: string, fields: LogFields): void {
  try {
    log[level](message, fields);
    return;
  } catch {
    // Fall through — the injected sink is gone, and the fallback below is the last one there is.
  }
  if (log === rootLogger) return;
  try {
    rootLogger[level](message, fields);
  } catch {
    // Both sinks are gone. Dropping the line is the only remaining option that still ends the
    // process, which is the outcome every caller of this file depends on.
  }
}

/**
 * Every check, run now, by name. A check that throws is `failing` — never an unhandled error —
 * and is reported through `report`, so an injected logger that throws cannot replace the answer.
 */
export function readinessChecks(): Readonly<Record<string, ReadinessStatus>> {
  return runReadinessChecks((name, thrown) => {
    report('warn', 'readiness check threw', { check: name, error: thrown });
  });
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
  const born = lifetime;
  return () => {
    if (done) return;
    done = true;
    // One from before `resetLifecycle()` drove the fresh count to -1, and the drain's in-flight
    // wait (idle only at exactly 0) then sat out its whole budget.
    if (born !== lifetime) return;
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

/** The grace the next drain will wait out — configured, else the environment's default. */
export function readinessGraceMs(): number {
  return graceMs ?? defaultReadinessGraceMs();
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
      report('error', 'shutdown hook failed', {
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
      report('warn', 'X_SHUTDOWN_TIMEOUT', {
        code: 'X_SHUTDOWN_TIMEOUT',
        cause: `the "${registration.name}" shutdown hook (phase: ${phase}) was still running at the ${deadlineMs}ms drain deadline and has been ABANDONED — the process exits without it, so anything it had in flight may be incomplete`,
        fix: `raise the budget past the work this hook does — set drain: { deadlineMs: 600_000 } in app.config.ts for a 10-minute job (configureLifecycle({ deadlineMs: 600_000 }) outside a framework boot) — and give the platform's kill timer at least as many seconds (x deploy --method helm sizes the chart's from it), or make the "${registration.name}" hook return once it has stopped accepting work rather than once it has finished`,
        hook: registration.name,
        phase,
      });
    }
  }
}

/**
 * The three phases, in order, under one budget. Never rejects — `drain()` depends on that.
 *
 * The readiness grace runs FIRST and OUTSIDE the budget: `state` is already `draining`, so
 * `/readyz` answers 503 while the listener still accepts what was routed here before the flip.
 * The deadline starts after it, so a chart's `terminationGracePeriodSeconds` must exceed
 * `readinessGraceMs + deadlineMs`.
 */
async function runDrain(signal: string): Promise<void> {
  try {
    const grace = readinessGraceMs();
    report('info', 'draining', { signal, deadlineMs, readinessGraceMs: grace, inflight });
    if (grace > 0) await Bun.sleep(grace);
    const reason: ShutdownReason = { signal, deadlineAt: systemClock.monotonic() + deadlineMs };
    await runPhase('accept', reason);

    // Real monotonic, like `deadlineAt` itself: `waitForIdle` sleeps on a real `setTimeout`, and
    // a budget read off an injected clock is a number that timer will never honour.
    const remaining = Math.max(0, reason.deadlineAt - systemClock.monotonic());
    const idle = await waitForIdle(remaining);
    if (!idle) {
      report('warn', 'X_SHUTDOWN_TIMEOUT', {
        code: 'X_SHUTDOWN_TIMEOUT',
        cause: `${inflight} in-flight operations still running after ${deadlineMs}ms`,
        fix: 'raise the budget past the slowest handler — set drain: { deadlineMs: 600_000 } in app.config.ts for a 10-minute one (configureLifecycle({ deadlineMs: 600_000 }) outside a framework boot) — and give the platform kill timer at least as many seconds, or shorten the handler',
      });
    }

    await runPhase('inflight', reason);
    await runPhase('close', reason);
  } catch (thrown) {
    // Nothing above should reach here — every hook is caught by `settleWithin` and every line
    // goes through `report`. If something does, the drain still ENDS: a rejected `drainPromise`
    // is a memo that re-rejects for every later caller and an unhandled rejection that kills the
    // process mid-drain, which is strictly worse than a drain that finished badly and said so.
    report('error', 'drain failed', { signal, error: thrown });
  } finally {
    state = 'stopped';
  }
  report('info', 'stopped', { signal });
}

/**
 * Idempotent: concurrent signals join the same drain, and so does a RE-ENTRANT one.
 *
 * The memo is published before `runDrain` is called, and that ordering is the whole of this
 * function. A hook may call back in here — `handle.stop()` in `@ultimat3/http` is `drain('manual')`
 * and an `accept` hook is exactly where a server stops listening — and `settleWithin` invokes a
 * hook SYNCHRONOUSLY, so the old `drainPromise = (async () => …)()` had not assigned yet when the
 * first hook ran: the re-entrant call saw `undefined`, started a second whole drain, and recursed
 * ~4,700 deep until the stack ran out, every level swallowed by `settleWithin` as
 * `shutdown hook failed`. Same rule as `packages/jobs/src/worker.ts` — guard and registration in
 * one synchronous step.
 */
export function drain(signal = 'manual'): Promise<void> {
  if (drainPromise !== undefined) return drainPromise;
  state = 'draining';
  let published!: () => void;
  drainPromise = new Promise<void>((resolve) => {
    published = resolve;
  });
  // Both settle paths, for the reason `installSignalHandlers` gives below: `runDrain` cannot
  // reject today — that is its `try/finally`, not luck — and a rejected memo would re-reject for
  // every later caller and end the process the drain was trying to end cleanly.
  void runDrain(signal).then(published, published);
  return drainPromise;
}

export function healthReport(mode: ReadinessMode = readinessMode): HealthReport {
  const checks = readinessChecks();
  const dependencies = Object.values(checks).every((status) => status === 'ok');
  return {
    state,
    // `ready` is the same predicate `/readyz` answers on, so a body and its status can never
    // disagree — a 200 whose body says `ready: false` is the bug this shares one source to avoid.
    // `'process'` mode leaves the checks OUT of it, and still reports every one of them below.
    ready: state === 'ready' && (mode === 'process' || dependencies),
    uptimeMs: Math.round(clock.monotonic() - startedAtMono),
    inflight,
    buildId: process.env['BUILD_ID'] ?? 'dev',
    checks,
    registered: readinessCheckCount(),
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

/**
 * Readiness: may this instance receive traffic? 503 while starting or draining, and — in the
 * default `'dependencies'` mode, or always with `deep` (`/readyz?deep=1`) — while any check fails.
 */
export function readyzPayload(options: { readonly deep?: boolean } = {}): HealthPayload {
  const body = healthReport(options.deep === true ? 'dependencies' : readinessMode);
  return { ok: body.ready, status: body.ready ? 200 : 503, body };
}

/** Test-only: forget all hooks and return to `starting`. */
export function resetLifecycle(): void {
  deadlineMs = DEFAULT_DEADLINE_MS;
  graceMs = undefined;
  readinessMode = 'dependencies';
  clock = systemClock;
  log = rootLogger;
  state = 'starting';
  startedAtMono = clock.monotonic();
  inflight = 0;
  lifetime += 1;
  registrations = [];
  drainPromise = undefined;
  idleWaiters = [];
  clearReadinessChecks();
}
