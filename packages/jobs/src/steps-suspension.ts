// A run that unwinds on purpose: the `StepSuspension` a `sleep` or `waitForEvent` throws, and the
// marker a timed-out wait persists. Split from `steps.ts` at the file-size ceiling — that file is
// the runner; this is the control flow the worker reads off what the runner threw.

/**
 * Control flow, not a failure: it must never be logged as an error or counted as an attempt.
 * Branded by string rather than `instanceof` so two copies of this module still agree.
 */
export class StepSuspension extends Error {
  static readonly brand = 'ultimate.jobs.suspension';
  readonly brand: string = StepSuspension.brand;
  readonly step: string;
  readonly resumeAt: number;
  readonly reason: 'sleep' | 'event';

  constructor(input: { step: string; resumeAt: number; reason: 'sleep' | 'event' }) {
    super(`step "${input.step}" suspended until ${new Date(input.resumeAt).toISOString()}`);
    this.name = 'StepSuspension';
    this.step = input.step;
    this.resumeAt = input.resumeAt;
    this.reason = input.reason;
  }
}

/**
 * What a timed-out `waitForEvent` persists, and maps back to `undefined` on replay. `undefined`
 * itself cannot survive a store — the pg driver writes `JSON.stringify(output ?? null)` — so the
 * timeout replayed as `null` and `evt === undefined` read as "an event arrived". A namespaced key
 * rather than a bare `{ timedOut: true }`, so no event payload can be mistaken for the marker.
 */
export const WAIT_TIMED_OUT = Object.freeze<Record<string, true>>({
  '~ultimate.waitTimedOut': true,
});

export function isWaitTimedOut(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    Object.keys(output).length === 1 &&
    (output as Record<string, unknown>)['~ultimate.waitTimedOut'] === true
  );
}

const WAIT_FLOOR_KEY = '~ultimate.waitFloor';
const WAIT_FLOOR_ID_KEY = '~ultimate.waitFloorId';

/** Where a wait's next search starts: at `afterMs`, and past the event `afterId` names. */
export interface WaitFloor {
  readonly afterMs: number;
  readonly afterId?: string;
}

/**
 * What a `waiting` record holds once its schema refused an event: where the next search starts.
 * `startedAt` cannot carry it, because the timeout counts from there. `find` answers the EARLIEST
 * event, so without this a repaired publisher's event sat behind the refused one until its TTL.
 * The refused event's id rides with its instant: a floor of `publishedAt + 1` skipped every valid
 * event stamped in the same millisecond. A record written before the id has `afterMs` alone.
 */
export const waitFloor = (floor: WaitFloor): Record<string, number | string> => ({
  [WAIT_FLOOR_KEY]: floor.afterMs,
  ...(floor.afterId === undefined ? {} : { [WAIT_FLOOR_ID_KEY]: floor.afterId }),
});

export function waitFloorOf(output: unknown): WaitFloor | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const record = output as Record<string, unknown>;
  const afterMs = record[WAIT_FLOOR_KEY];
  if (typeof afterMs !== 'number') return undefined;
  const afterId = record[WAIT_FLOOR_ID_KEY];
  return typeof afterId === 'string' ? { afterMs, afterId } : { afterMs };
}

/**
 * What an incomplete step throws while the run is UNWINDING: the body replays only to re-register
 * its compensators, and the first step that never completed is where the forward path stops. The
 * `StepSuspension` shape, and private: `executeJob` reads it, then calls `runner.unwind()`.
 */
export class UnwindReached extends Error {
  static readonly brand = 'ultimate.jobs.unwind-reached';
  readonly brand: string = UnwindReached.brand;
  readonly step: string;

  constructor(step: string) {
    super(`step "${step}" never completed, and the run is unwinding`);
    this.name = 'UnwindReached';
    this.step = step;
  }
}

export function isUnwindReached(error: unknown): error is UnwindReached {
  return error instanceof Error && (error as { brand?: unknown }).brand === UnwindReached.brand;
}

export function isStepSuspension(error: unknown): error is StepSuspension {
  return error instanceof Error && (error as { brand?: unknown }).brand === StepSuspension.brand;
}
