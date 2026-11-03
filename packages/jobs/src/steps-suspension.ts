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

/**
 * What a `waiting` record holds once its schema refused an event: where the next search starts.
 * `startedAt` cannot carry it, because the timeout counts from there. `find` answers the EARLIEST
 * event, so without this a repaired publisher's event sat behind the refused one until its TTL.
 */
export const waitFloor = (afterMs: number): Record<string, number> => ({
  [WAIT_FLOOR_KEY]: afterMs,
});

export function waitFloorOf(output: unknown): number | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const floor = (output as Record<string, unknown>)[WAIT_FLOOR_KEY];
  return typeof floor === 'number' ? floor : undefined;
}

export function isStepSuspension(error: unknown): error is StepSuspension {
  return error instanceof Error && (error as { brand?: unknown }).brand === StepSuspension.brand;
}
