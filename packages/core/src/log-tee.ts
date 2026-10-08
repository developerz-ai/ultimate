// Single responsibility: `addLogSink` — the supported tee of every default-writer log line, beside
// the process's streams and never instead of them (`setLogSink` is the test seam that replaces).
// Total: a sink that throws or logs cannot cost the line, the other sinks, or the process.

import { systemClock } from './clock';
import { renderThrowable } from './error-render';
import type { LogLevel, LogSink } from './logger';

let sinks: readonly LogSink[] = [];
/** Set while sinks run: a line a sink logs reaches the streams, never the tee it came from. */
let teeing = false;
/** Each sink says it failed ONCE — a sink that throws on every line would double the log. */
const reported = new WeakSet<LogSink>();

/**
 * Tee every line the process logger writes — the complete JSON line, AFTER redaction, and its
 * level — to `sink`, in addition to stdout/stderr (or a `setLogSink` test sink). Returns the
 * unsubscribe; calling it twice is a no-op.
 *
 * The population is `setLogSink`'s: every logger without its own `writer` — `logger`, every
 * `child()` of it, `ctx.logger`. Sinks run synchronously, in the order added, after the line is
 * written; one added while a line is being teed sees the next line, not that one. A sink that
 * throws is skipped for that line and reported once as `log.sink_failed` on the streams; a line a
 * sink logs itself is written but not teed back into the sinks.
 */
export function addLogSink(sink: LogSink): () => void {
  sinks = [...sinks, sink];
  return () => {
    sinks = sinks.filter((candidate) => candidate !== sink);
  };
}

/** How many sinks are teeing now — a count that climbs across a test is an unsubscribe missed. */
export function logTeeCount(): number {
  return sinks.length;
}

/** Called by the logger's default writer after `write` has put the line on the streams. */
export function teeLogLine(line: string, level: LogLevel, write: LogSink): void {
  if (teeing || sinks.length === 0) return;
  teeing = true;
  try {
    for (const sink of sinks) {
      try {
        sink(line, level);
      } catch (thrown) {
        reportOnce(sink, thrown, write);
      }
    }
  } finally {
    teeing = false;
  }
}

/** Straight to the streams, never through the logger: the logger is what called the sink. */
function reportOnce(sink: LogSink, thrown: unknown, write: LogSink): void {
  if (reported.has(sink)) return;
  reported.add(sink);
  try {
    write(
      JSON.stringify({
        ts: systemClock.now().toISOString(),
        level: 'warn',
        msg: 'log.sink_failed',
        cause: `a log sink added with addLogSink threw ${renderThrowable(thrown)}; it is skipped for that line and still called for the next — this is reported once per sink`,
        fix: 'addLogSink((line, level) => { try { store(line, level); } catch { /* drop it: a sink must not throw */ } })',
      }),
      'warn',
    );
  } catch {
    // The streams themselves are gone; there is nowhere left to say it.
  }
}
