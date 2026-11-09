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
const WAIT_HORIZON_KEY = '~ultimate.waitHorizon';
const WAIT_SINCE_HORIZON_KEY = '~ultimate.waitSinceHorizon';
const WAIT_REFUSED_KEY = '~ultimate.waitRefused';

/**
 * Where a wait's next search starts: at `afterMs`, past the event `afterId` names — and, given a
 * `horizon` (`EventLookup.mark`), at every event that horizon could not see, whatever its stamp.
 */
export interface WaitFloor {
  readonly afterMs: number;
  readonly afterId?: string;
  readonly horizon?: string;
  /** The MARK's horizon: the wait's own line, kept by every refusal (`EventSince`). */
  readonly sinceHorizon?: string;
  /** Events refused BEHIND the cursor, excluded by id (`EventSince.refused`). */
  readonly refused?: readonly string[];
}

/**
 * What a `waiting` record holds once its schema refused an event: where the next search starts.
 * `startedAt` cannot carry it, because the timeout counts from there. `find` answers the EARLIEST
 * event, so without this a repaired publisher's event sat behind the refused one until its TTL.
 * The refused event's id rides with its instant: a floor of `publishedAt + 1` skipped every valid
 * event stamped in the same millisecond. A record written before the id has `afterMs` alone.
 * Over a bus that marks (`EventLookup.mark`), every parked wait holds one from its first park: the
 * horizon rides here, since a re-poll must search under the line its wait began at.
 */
export const waitFloor = (
  floor: WaitFloor,
): Record<string, number | string | readonly string[]> => ({
  [WAIT_FLOOR_KEY]: floor.afterMs,
  ...(floor.afterId === undefined ? {} : { [WAIT_FLOOR_ID_KEY]: floor.afterId }),
  ...(floor.horizon === undefined ? {} : { [WAIT_HORIZON_KEY]: floor.horizon }),
  ...(floor.sinceHorizon === undefined ? {} : { [WAIT_SINCE_HORIZON_KEY]: floor.sinceHorizon }),
  ...(floor.refused === undefined || floor.refused.length === 0
    ? {}
    : { [WAIT_REFUSED_KEY]: floor.refused }),
});

export function waitFloorOf(output: unknown): WaitFloor | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const record = output as Record<string, unknown>;
  const afterMs = record[WAIT_FLOOR_KEY];
  if (typeof afterMs !== 'number') return undefined;
  const afterId = record[WAIT_FLOOR_ID_KEY];
  const horizon = record[WAIT_HORIZON_KEY];
  const sinceHorizon = record[WAIT_SINCE_HORIZON_KEY];
  const refused = record[WAIT_REFUSED_KEY];
  return {
    afterMs,
    ...(typeof afterId === 'string' ? { afterId } : {}),
    ...(typeof horizon === 'string' ? { horizon } : {}),
    ...(typeof sinceHorizon === 'string' ? { sinceHorizon } : {}),
    ...(Array.isArray(refused)
      ? { refused: refused.filter((id): id is string => typeof id === 'string') }
      : {}),
  };
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
