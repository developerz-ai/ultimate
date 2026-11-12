// Single responsibility: what the `error-map` stage's line costs for a refusal. Every 4xx is counted
// (`http_refusals_total{code}`); a ROUTINE one — the login wall a scanner walks into — is logged at
// `info` once per route per minute and at `debug` after that, so one scanner is not five lines a
// minute (measured in production) and the count still says how many there were.

import { counter } from '@ultimat3/core';
import { errorLogLevel } from './error-log-level';

export type RefusalLogLevel = 'error' | 'warn' | 'info' | 'debug';

/** How long one route's routine refusal stays at `debug` after the `info` line that stood for it. */
export const ROUTINE_REFUSAL_WINDOW_MS = 60_000;

/**
 * route → when its last `info` line was written (`performance.now()`). Bounded by the route table;
 * the ceiling below is the belt for a table nobody expected, never a tuning knob.
 */
const lastInfo = new Map<string, number>();
const MAX_ROUTES = 4_096;

const refusals = () =>
  counter('http_refusals_total', {
    unit: '{request}',
    description: 'Requests refused with a 4xx before or by the handler, by error code',
  });

export interface RefusalLine {
  readonly status: number;
  readonly code: string;
  readonly error: unknown;
  /** The route PATTERN, or the unmatched label — one window per route, never per path. */
  readonly route: string;
  /** `performance.now()` at the decision; the request's own clock read, injected by a test. */
  readonly nowMs: number;
}

/**
 * The level for this failure's line, and the count. A routine refusal is the one
 * `errorLogLevel` answers `info` for although its status is otherwise `warn` (401/403/429): the
 * marker is `routineRefusal()`'s, read through the level it already decides, so a credential
 * checker's own `X_UNAUTHENTICATED` stays `warn` and is never demoted here.
 */
export const refusalLogLevel = (line: RefusalLine): RefusalLogLevel => {
  const level = errorLogLevel(line.status, line.error);
  if (line.status < 400 || line.status >= 500) return level;
  refusals().add(1, { code: line.code });
  const routine =
    level === 'info' && (line.status === 401 || line.status === 403 || line.status === 429);
  if (!routine) return level;
  const last = lastInfo.get(line.route);
  if (last !== undefined && line.nowMs - last < ROUTINE_REFUSAL_WINDOW_MS) return 'debug';
  if (lastInfo.size >= MAX_ROUTES) lastInfo.clear();
  lastInfo.set(line.route, line.nowMs);
  return 'info';
};

/** TEST SEAM: forget every route's window. */
export const resetRefusalLog = (): void => {
  lastInfo.clear();
};
