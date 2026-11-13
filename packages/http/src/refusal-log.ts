// Single responsibility: what the `error-map` stage's line costs for a refusal. Every 4xx is counted
// (`http_refusals_total{code}`); one logged at `info` — the login wall a scanner walks into, a 404,
// 400 or 422 — is `info` once per route and code per minute and `debug` after that, so one scanner
// is not a line per probe (measured in production) and the count still says how many there were.

import { counter } from '@ultimat3/core';
import { errorLogLevel } from './error-log-level';

export type RefusalLogLevel = 'error' | 'warn' | 'info' | 'debug';

/** How long one route's `info` refusal stays at `debug` after the `info` line that stood for it. */
export const ROUTINE_REFUSAL_WINDOW_MS = 60_000;

/**
 * route + code → when its last `info` line was written (`performance.now()`). Bounded by the route
 * table times the code registry; the ceiling below is the belt for a table nobody expected, never a
 * tuning knob. Keyed by the code too, so a 401 on a route never hides the first 404 on it.
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
 * The level for this failure's line, and the count. Every 4xx `errorLogLevel` answers `info` for is
 * windowed: a `routineRefusal()` (401/403/429 otherwise `warn`) and the caller's own mistakes — 404,
 * 400, 422 — which an unauthenticated scanner otherwise turned into one line per probe. A `warn`
 * (a credential checker's own `X_UNAUTHENTICATED`) is never demoted here.
 */
export const refusalLogLevel = (line: RefusalLine): RefusalLogLevel => {
  const level = errorLogLevel(line.status, line.error);
  if (line.status < 400 || line.status >= 500) return level;
  refusals().add(1, { code: line.code });
  if (level !== 'info') return level;
  const key = `${line.route}\u0000${line.code}`;
  const last = lastInfo.get(key);
  if (last !== undefined && line.nowMs - last < ROUTINE_REFUSAL_WINDOW_MS) return 'debug';
  if (lastInfo.size >= MAX_ROUTES) lastInfo.clear();
  lastInfo.set(key, line.nowMs);
  return 'info';
};

/** TEST SEAM: forget every route's window. */
export const resetRefusalLog = (): void => {
  lastInfo.clear();
};
