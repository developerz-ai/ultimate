// One rule: how a declared rate limit moved. A tightened limit refuses a caller the old pair
// served, which is the definition of breaking — and it is the one contract change that leaves
// every schema in the manifest untouched, so nothing else in the diff can see it. A limit resolved
// per call is judged as `diff-meter.ts` judges a per-call meter.

import type { ManifestChange } from './diff-change';
import type { ActionFact, RateLimitFact } from './schema';

/** A limit resolved per call: only its window is a static fact. */
interface PerCallReading {
  readonly perCall: number;
}

/** No declaration at all, a declaration, or one this reader cannot make sense of. */
type RateLimitReading = RateLimitFact | PerCallReading | 'none' | 'unreadable';

/**
 * Introducing a limit where there was none is the same event at its extreme: a client that was
 * never throttled now can be.
 */
export function diffRateLimit(
  path: string,
  before: ActionFact,
  after: ActionFact,
): readonly ManifestChange[] {
  const declared = readRateLimit(before);
  const next = readRateLimit(after);
  if (declared === 'unreadable' || next === 'unreadable') return [];
  const at = `${path}.rateLimit`;

  if (declared === 'none') {
    if (next === 'none') return [];
    return [
      {
        kind: 'breaking',
        path: at,
        detail: `rate limit introduced (${render(next)}); an unthrottled caller can now be refused`,
      },
    ];
  }
  if (next === 'none') {
    return [{ kind: 'additive', path: at, detail: `rate limit removed (was ${render(declared)})` }];
  }
  if ('perCall' in declared || 'perCall' in next) return perCall(at, declared, next);
  if (tighter(declared, next)) {
    return [
      {
        kind: 'breaking',
        path: at,
        detail: `rate limit tightened ${render(declared)} -> ${render(next)}; callers at the old rate are refused`,
      },
    ];
  }
  if (tighter(next, declared)) {
    return [
      {
        kind: 'additive',
        path: at,
        detail: `rate limit loosened ${render(declared)} -> ${render(next)}`,
      },
    ];
  }
  return [];
}

/**
 * Both halves, because either one alone refuses somebody: `limit` is the burst a caller may
 * spend at once and `limit / windowMs` is the rate it refills at, so a larger burst on a slower
 * refill still turns away a client the old pair served. Cross-multiplied rather than divided —
 * both windows are positive, and an exact integer comparison cannot invent a change out of a
 * rounding difference in a file that is diffed on every build.
 */
const tighter = (from: RateLimitFact, to: RateLimitFact): boolean =>
  to.limit < from.limit || to.limit * from.windowMs < from.limit * to.windowMs;

/**
 * A per-call limit is the app's function of the caller, so no static number proves a caller the
 * old build served still is: a move to or from one is breaking. Two of them are taken as the same
 * resolver over a moved window, where a longer window refills slower.
 */
function perCall(
  at: string,
  from: RateLimitFact | PerCallReading,
  to: RateLimitFact | PerCallReading,
): readonly ManifestChange[] {
  const moved = `${render(from)} -> ${render(to)}`;
  if (!('perCall' in from) || !('perCall' in to)) {
    return [
      {
        kind: 'breaking',
        path: at,
        detail: `rate limit ${moved}; no static limit proves an old caller is still served`,
      },
    ];
  }
  if (to.perCall === from.perCall) return [];
  return to.perCall > from.perCall
    ? [{ kind: 'breaking', path: at, detail: `per-call rate limit window lengthened ${moved}` }]
    : [{ kind: 'additive', path: at, detail: `per-call rate limit window shortened ${moved}` }];
}

const render = (limit: RateLimitFact | PerCallReading): string =>
  'perCall' in limit ? `per-call/${limit.perCall}ms` : `${limit.limit}/${limit.windowMs}ms`;

function readRateLimit(fact: ActionFact): RateLimitReading {
  const value: unknown = fact.rateLimit;
  const perCallValue: unknown = fact.rateLimitPerCall;
  if (perCallValue !== undefined && perCallValue !== null) {
    // `describe()` publishes one or the other, never both: a file carrying both is not its output.
    if (value !== undefined && value !== null) return 'unreadable';
    if (typeof perCallValue !== 'object') return 'unreadable';
    const windowMs = (perCallValue as Record<string, unknown>)['windowMs'];
    return positive(windowMs) ? { perCall: windowMs } : 'unreadable';
  }
  if (value === undefined || value === null) return 'none';
  if (typeof value !== 'object') return 'unreadable';
  const record = value as Record<string, unknown>;
  const limit = record['limit'];
  const windowMs = record['windowMs'];
  // The same two conditions `toBucket` enforces at mount: a non-positive window is an infinite
  // refill and a sub-token limit closes the endpoint, so neither describes a limit to compare.
  if (!positive(limit) || !positive(windowMs)) return 'unreadable';
  return { limit, windowMs };
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
