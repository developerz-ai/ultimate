// The container boot's timeline: one `boot.phase {role, name, ms}` line as each phase ends. A boot
// spent seconds between two unrelated log lines — a worker importing every page for an unstamped
// build id — and nothing said which step it was (plan 101, 14 U12).

import type { Clock, Role } from '@ultimat3/core';
import { logger, systemClock } from '@ultimat3/core';

/** The phases a serving boot runs, in order. A name not here is not a phase. */
export type BootPhase = 'services' | 'app-load' | 'app-checks' | 'build-id' | 'web' | 'roles';

export interface BootTimeline {
  /** Ends `name`: logs its milliseconds since the previous phase ended, or since the start. */
  phase(name: BootPhase): void;
  /** Whole milliseconds since the timeline started. */
  totalMs(): number;
}

/** Starts the clock. The process's own clock by default; a test hands a frozen one. */
export function bootTimeline(role: Role, clock: Clock = systemClock): BootTimeline {
  const started = clock.monotonic();
  let last = started;
  return {
    phase(name) {
      const now = clock.monotonic();
      logger.info('boot.phase', { role, name, ms: Math.round(now - last) });
      last = now;
    },
    totalMs: () => Math.round(clock.monotonic() - started),
  };
}
