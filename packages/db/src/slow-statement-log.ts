// Single responsibility: one grep-able `warn` line per slow statement, from the `db.statement` bus
// event — the normalised shape (never a bound value), duration, rows and, through the logger's
// context fields, the request/job ids. Sampled to one line per shape per window, memo bounded.
// The runtime decides whether it runs (500 ms in production, off in tests); this is the mechanism.

import {
  type DbStatementEvent,
  isUltimateError,
  logger,
  SEMCONV,
  SEMCONV_VALUES,
  subscribe,
} from '@ultimat3/core';
import { statementVerb } from './statement-shape';

/** The production default the runtime passes as `thresholdMs`. */
export const SLOW_STATEMENT_THRESHOLD_MS = 500;
/** One line per shape per this long; the rest are counted onto the next line as `suppressed`. */
export const SLOW_STATEMENT_WINDOW_MS = 10_000;
/** Shapes remembered at once. A process with more distinct slow shapes forgets the oldest first. */
export const SLOW_STATEMENT_SHAPES_MAX = 512;
/** A bulk insert's text can run to megabytes; a log line carries its head. */
const SHAPE_CHARS_MAX = 2_000;
const WHITESPACE = /\s+/g;

export interface SlowStatementLogOptions {
  /** Statements at or over this many ms log. `0` (or less) is off: nothing subscribes. */
  readonly thresholdMs: number;
  readonly windowMs?: number | undefined;
  /** Monotonic ms, for the sampling window only. Defaults to `performance.now`. */
  readonly now?: (() => number) | undefined;
}

interface Seen {
  readonly at: number;
  suppressed: number;
}

/** The text with whitespace collapsed, capped: already `$n`-parameterised by `sql()`. */
function shapeOf(text: string): string {
  const shape = text.replace(WHITESPACE, ' ').trim();
  return shape.length > SHAPE_CHARS_MAX ? `${shape.slice(0, SHAPE_CHARS_MAX - 3)}...` : shape;
}

function lineOf(
  event: DbStatementEvent,
  shape: string,
  suppressed: number,
): Record<string, unknown> {
  const verb = statementVerb(event.text);
  const attribution = event.attribution;
  return {
    [SEMCONV.dbSystemName]: SEMCONV_VALUES.dbSystemPostgres,
    [SEMCONV.dbQueryText]: shape,
    ...(verb === '' ? {} : { [SEMCONV.dbOperationName]: verb.toUpperCase() }),
    [SEMCONV.dbResponseReturnedRows]: event.rows,
    durationMs: Math.round(event.durationMs),
    ...(attribution === undefined
      ? {}
      : { attribution: `${attribution.entity}.${attribution.op}` }),
    ...(event.error === undefined
      ? {}
      : { [SEMCONV.errorType]: isUltimateError(event.error) ? event.error.code : '_OTHER' }),
    ...(suppressed === 0 ? {} : { suppressed }),
  };
}

/**
 * Subscribe the slow-statement line. Returns the unsubscribe — wire it into the drain. Bound values
 * never reach the line: the event's `values` is not read at all.
 */
export function slowStatementLog(options: SlowStatementLogOptions): () => void {
  const { thresholdMs } = options;
  if (!(thresholdMs > 0)) return () => undefined;
  const windowMs = options.windowMs ?? SLOW_STATEMENT_WINDOW_MS;
  const now = options.now ?? (() => performance.now());
  // Insertion order is last-logged order: a re-log deletes and re-inserts, so the first key is
  // always the shape that logged longest ago — the one eviction drops.
  const seen = new Map<string, Seen>();

  return subscribe('db.statement', ({ payload }) => {
    if (payload.durationMs < thresholdMs) return;
    const shape = shapeOf(payload.text);
    const at = now();
    const last = seen.get(shape);
    if (last !== undefined && at - last.at < windowMs) {
      last.suppressed += 1;
      return;
    }
    seen.delete(shape);
    if (seen.size >= SLOW_STATEMENT_SHAPES_MAX) {
      const oldest = seen.keys().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
    seen.set(shape, { at, suppressed: 0 });
    logger.warn('db.statement.slow', lineOf(payload, shape, last?.suppressed ?? 0));
  });
}
