// What a log viewer shows: the lines at or above a level, matching a filter, and only the newest
// `cap` of them — a live log trims from the top as it grows, so a long run never holds every line.

import { finiteCount } from '@ultimat3/core';

export const LOG_VIEWER_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogViewerLevel = (typeof LOG_VIEWER_LEVELS)[number];

/** The most lines a viewer keeps by default; older ones are dropped and counted. */
export const LOG_VIEWER_CAP = 10_000;

export interface LogLine {
  /** Unique and stable: the row keeps its node under it as lines arrive. */
  readonly id: string;
  readonly text: string;
  readonly level?: LogViewerLevel | undefined;
  readonly at?: Date | string | number | undefined;
  /** A line that names something elsewhere links to it. */
  readonly href?: string | undefined;
}

export interface LogWindow {
  readonly lines: readonly LogLine[];
  /** Matching lines left out above the window by the cap. */
  readonly dropped: number;
}

/**
 * `minimum` keeps that level and every level above it; a line with no level passes any minimum.
 * `query` matches case-insensitively in `locale`. The newest `cap` matches are kept.
 */
export function logWindow(
  lines: readonly LogLine[],
  options: {
    readonly minimum?: LogViewerLevel | undefined;
    readonly query?: string | undefined;
    readonly cap?: number | undefined;
    readonly locale: string;
  },
): LogWindow {
  const cap = finiteCount('LogViewer', 'cap', options.cap ?? LOG_VIEWER_CAP, 1);
  const floor = options.minimum === undefined ? 0 : LOG_VIEWER_LEVELS.indexOf(options.minimum);
  const needle = (options.query ?? '').trim().toLocaleLowerCase(options.locale);
  const matching = lines.filter(
    (line) =>
      (line.level === undefined || LOG_VIEWER_LEVELS.indexOf(line.level) >= floor) &&
      (needle === '' || line.text.toLocaleLowerCase(options.locale).includes(needle)),
  );
  const dropped = Math.max(0, matching.length - cap);
  return { lines: dropped === 0 ? matching : matching.slice(dropped), dropped };
}
