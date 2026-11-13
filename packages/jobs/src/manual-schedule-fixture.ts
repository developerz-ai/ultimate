// An `IntervalScheduler` a test fires by hand — what `WorkerOptions.schedule` and
// `createFleetSlots({ schedule })` take. The renewals a worker hands over are then a table the
// test reads (which intervals were armed, which were handed back) and a beat that runs when the
// test says so, never on the wall clock.

import type { IntervalScheduler } from './renewal-timer';

export interface ManualSchedule {
  readonly schedule: IntervalScheduler;
  /** Every renewal still armed, with the interval it was handed. A cancelled one leaves. */
  readonly armed: ReadonlyMap<() => void, number>;
  /** The armed renewals at `intervalMs`, or all of them. */
  ticks(intervalMs?: number): readonly (() => void)[];
  /** One beat of each armed renewal (at `intervalMs`, or all), then the turns its answer needs. */
  fire(intervalMs?: number): Promise<void>;
}

const TURNS = 10;

export function manualSchedule(): ManualSchedule {
  const armed = new Map<() => void, number>();
  const ticks = (intervalMs?: number): readonly (() => void)[] =>
    [...armed]
      .filter(([, every]) => intervalMs === undefined || every === intervalMs)
      .map(([tick]) => tick);
  return {
    armed,
    schedule: (tick, intervalMs) => {
      armed.set(tick, intervalMs);
      return () => {
        armed.delete(tick);
      };
    },
    ticks,
    async fire(intervalMs) {
      for (const tick of ticks(intervalMs)) tick();
      for (let turn = 0; turn < TURNS; turn += 1) {
        await new Promise((done) => setImmediate(done));
      }
    },
  };
}
