// An interval scheduler on the FROZEN clock: a tick fires when a test moves time past it, never on
// the wall clock. What the `runJobs` fixture renews its leases and slots on, so a running body
// hears its cancel at the next `clock.advance()` and no job test pays for a real-time loop.

import type { IntervalScheduler } from '@ultimat3/jobs';
import { frozenNow, onClockMoved } from './determinism';

interface Armed {
  readonly tick: () => void;
  readonly everyMs: number;
  dueAt: number;
}

export interface FrozenScheduler extends Disposable {
  readonly schedule: IntervalScheduler;
  /** Ticks armed right now. A number that does not fall back to `0` is a renewal nobody stopped. */
  armed(): number;
}

/**
 * One tick per armed renewal per move, however far the clock jumped: a renewal is idempotent, and
 * firing a three-day advance as 259,200 one-second ticks would be the wall-clock loop again.
 */
export function frozenScheduler(): FrozenScheduler {
  const timers = new Set<Armed>();
  const stopListening = onClockMoved(() => {
    const now = frozenNow().getTime();
    for (const timer of [...timers]) {
      if (!timers.has(timer) || timer.dueAt > now) continue;
      timer.dueAt = now + timer.everyMs;
      timer.tick();
    }
  });
  const schedule: IntervalScheduler = (tick, everyMs) => {
    const timer: Armed = { tick, everyMs, dueAt: frozenNow().getTime() + everyMs };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  };
  return {
    schedule,
    armed: () => timers.size,
    [Symbol.dispose]: () => {
      stopListening();
      timers.clear();
    },
  };
}
