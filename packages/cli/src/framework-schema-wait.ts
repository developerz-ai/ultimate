// A serving role over a schema still behind its build — the framework stamp or the app's ledger:
// wait for the migrate step, bounded by `ULTIMATE_SCHEMA_WAIT_MS`, on core's one backoff curve,
// saying so once — never exit at once and crash-loop a rollout that started the roles before the
// migrate Job finished (plan 101, D2). A SIGTERM mid-wait is a drain, never a wait to the deadline.

import type { Random, SleepClock } from '@ultimat3/core';
import {
  ambientClock,
  backoffDelay,
  failureStreak,
  isDraining,
  onShutdown,
  UltimateError,
} from '@ultimat3/core';
import { SCHEMA_WAIT_ENV } from './framework-schema-stamp';

export { SCHEMA_WAIT_ENV };

/**
 * Five minutes: a migrate Job that has not stamped the database by then is failing, not slow, and
 * it is the default `helm --wait` budget, so a rollout gives up on the pod no sooner than this.
 */
export const DEFAULT_SCHEMA_WAIT_MS = 300_000;

/** The first wait and the ceiling of any one: a catalog read every 15s at worst, per pod. */
const WAIT_BASE_MS = 1_000;
const WAIT_MAX_MS = 15_000;

/** `X_CONFIG_INVALID`: a deadline that is not whole milliseconds is refused, never read as NaN. */
export class SchemaWaitInvalidError extends UltimateError {
  constructor(value: string) {
    super({
      code: 'X_CONFIG_INVALID',
      cause: `${SCHEMA_WAIT_ENV} is "${value}"; it is the whole number of milliseconds a serving role waits for the migrate step to bring the schema to its build, 0 to refuse at once`,
      // Literal: a spliced value in a command position is what the fix-shell-arg ratchet refuses.
      // `framework-schema-wait.test.ts` holds it equal to the two constants.
      fix: 'docker run -e ULTIMATE_SCHEMA_WAIT_MS=300000 <image>   # or unset it for the default',
      meta: { key: SCHEMA_WAIT_ENV },
    });
  }
}

/** The declared deadline: unset or blank is the default; anything but decimal digits is refused. */
export function schemaWaitMsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[SCHEMA_WAIT_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_SCHEMA_WAIT_MS;
  const ms = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(ms)) throw new SchemaWaitInvalidError(raw);
  return ms;
}

export interface SchemaWaitOptions {
  /** How long to wait; the boot's `schemaWaitMsFromEnv(env)`. `0` refuses on the first read. */
  readonly deadlineMs: number;
  readonly clock?: SleepClock;
  readonly random?: Random;
}

/** One read's answer: ready with what the caller reports, or the refusal it would end in. */
export type SchemaCheck<T> =
  | { readonly ready: true; readonly value: T }
  | {
      readonly ready: false;
      /** Built with how long the role waited, or without when it refuses on the first read. */
      readonly refuse: (waitedMs?: number) => UltimateError;
      /** No wait can help — a newer major migrated: refused on this read. */
      readonly atOnce?: boolean;
    };

/**
 * `check` until it is ready, the deadline passes, or a drain begins. One line when the wait opens
 * and one if its cause changes — the framework stamp landing with the app's migrations still
 * pending is news — and one when it ends; never a line per read per pod.
 */
export async function waitForSchema<T>(
  check: () => Promise<SchemaCheck<T>>,
  options: SchemaWaitOptions,
): Promise<T> {
  const { deadlineMs } = options;
  const clock = options.clock ?? ambientClock();
  const startedAt = clock.monotonic();
  const streak = failureStreak({
    event: 'ultimate schema waiting',
    recoveredEvent: 'ultimate schema applied',
    level: 'warn',
    fields: { deadlineMs },
  });
  const stop = new AbortController();
  // The `accept` phase, the first: the boot is under `holdWhileBooting`'s handlers, so a SIGTERM
  // here is a drain, and this wait is the boot work it must end.
  const unregister = onShutdown('cli:schema-wait', () => stop.abort(), { phase: 'accept' });
  // The refusal a drain ends the wait with: the last verdict's, or — when the drain lands on the
  // first read — the drain itself, since nothing was read to refuse with.
  let refuse: ((waitedMs?: number) => UltimateError) | undefined;
  const drained = (): UltimateError => (refuse ?? waitDrained)(clock.monotonic() - startedAt);
  try {
    // A SIGTERM while the boot still loaded modules ran the `accept` phase before this hook existed,
    // so its abort was never heard: refuse before the first read, which an unreachable database
    // would hold past the pod's grace.
    if (isDraining()) throw drained();
    for (let attempt = 1; ; attempt += 1) {
      // Raced against the drain like the sleep below: a read on an unreachable database hangs
      // until the pool gives up — ~125 s on a worker, past the pod's grace, so SIGKILL (137).
      const verdict = await untilAborted(check(), stop.signal, drained);
      if (verdict.ready) {
        streak.passed();
        return verdict.value;
      }
      refuse = verdict.refuse;
      const waitedMs = clock.monotonic() - startedAt;
      if (verdict.atOnce === true || deadlineMs === 0) throw verdict.refuse();
      if (waitedMs >= deadlineMs || stop.signal.aborted || isDraining()) {
        throw verdict.refuse(waitedMs);
      }
      streak.failed(verdict.refuse());
      const delay = backoffDelay({
        attempt,
        base: WAIT_BASE_MS,
        max: WAIT_MAX_MS,
        jitter: 'equal',
        random: options.random,
      });
      try {
        // Cut to the deadline: the last read lands ON it, never a whole backoff past it.
        await clock.sleep(Math.min(delay, deadlineMs - waitedMs), stop.signal);
      } catch (error) {
        // The drain's abort ends the wait with the refusal `holdWhileBooting` turns into an exit
        // of `drainExitCode()`; any other rejection is the clock's own, and is rethrown as it came.
        if (!stop.signal.aborted) throw error;
        throw drained();
      }
    }
  } finally {
    unregister();
  }
}

/**
 * `X_DRAINING`, core's code for work cut short by shutdown: a drain landed on the first read, so
 * no verdict exists to refuse with. `holdWhileBooting` turns it into an exit of `drainExitCode()`.
 */
function waitDrained(waitedMs = 0): UltimateError {
  return new UltimateError({
    code: 'X_DRAINING',
    cause: `a drain began while this role's first schema read was in flight (${String(waitedMs)} ms in), so the boot ended there instead of waiting on a database that may never answer`,
    fix: 'x deploy verify --url https://app.example.com --build "$BUILD_ID"   # nothing to do on this pod: its replacement boots and reads the schema again',
    retry: 'terminal',
    meta: { waitedMs },
  });
}

/**
 * `work`, unless `signal` aborts first — then `refusal()`, thrown. The abandoned read is not
 * cancelled (the pool's own bound retires it); `Promise.race` keeps its late rejection handled.
 */
function untilAborted<V>(
  work: Promise<V>,
  signal: AbortSignal,
  refusal: () => UltimateError,
): Promise<V> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(refusal());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}
