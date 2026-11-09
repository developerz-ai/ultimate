// Single responsibility: publish one written process-logger line as `log.record` on the
// instrumentation bus — the feed the OTLP logs exporter and any app subscriber read. Total: a
// subscriber's throw never reaches the `log.*` call that wrote the line.

import type { Clock } from './clock';
import { instrument } from './instrument';
import type { LogLevel } from './logger';

/**
 * `log.record`, after the line is written. Swallowed, unlike every other event on the bus: a log
 * call is TOTAL (see `serialiseValue`), and a subscriber that throws must not turn `log.error`
 * inside some `catch` into a second failure replacing the first.
 */
export function publishRecord(
  clock: Clock,
  level: Exclude<LogLevel, 'silent'>,
  message: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    instrument('log.record', { at: epochMs(clock), level, message, fields });
  } catch {
    // The line is already on the streams; the subscriber's failure is its own.
  }
}

/** The clock's reading in epoch ms, `0` for a clock that cannot be read — `timestamp`'s rule. */
function epochMs(clock: Clock): number {
  try {
    const at = clock.now().getTime();
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}
