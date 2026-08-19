// The ONE `/robots.txt` read the gate performs when the caller injects no `fetchText`.
//
// It exists as its own file because the production default was the only network call in this
// package with no deadline, no size cap and no proxy — and `scrape-run.ts` builds the gate with no
// `fetchText`, so production always took it. Every existing gate test injected one, which is how a
// read that could park a run forever stayed green.

import { readWithinLimit } from '@ultimat3/core';
import type { RobotsFetch } from './robots';

/**
 * A deadline is applied ALWAYS, proxy or no proxy, session or no session: the failure it prevents
 * is a hung origin whose cached promise then parks every later navigation to that origin, past
 * `ctx.signal`, the watchdog and the job timeout. Ten seconds is long for a static text file and
 * short against a slow-loris.
 */
export const DEFAULT_ROBOTS_TIMEOUT_MS = 10_000;

/** Google's own documented ceiling for the file, and generous for a list of path prefixes. */
export const DEFAULT_ROBOTS_MAX_BYTES = 500 * 1024;

export interface RobotsFetchInit {
  /** Per-read wall clock. Defaults to `DEFAULT_ROBOTS_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
  /** The run's cancellation, when there is one. Composed with the deadline, never replacing it. */
  readonly signal?: AbortSignal | undefined;
  /**
   * The SAME proxy the browser dialled through, when the session has one. Optional by design:
   * proxies are an opt-in leg, and an origin reachable directly must still be asked for its rules.
   */
  readonly proxy?: string | undefined;
  readonly maxBytes?: number | undefined;
  /** The platform `fetch`, injectable so the default path itself is testable. */
  readonly fetch?: typeof fetch | undefined;
}

/**
 * Reads `robotsUrl`, or answers `undefined` — which the gate reads as "no restrictions", the
 * standard's own answer for a file it cannot obtain. A deadline that fires, a body past the cap
 * and a 404 are all the same answer on purpose: none of them is evidence of a rule.
 */
export function robotsFetcher(init: RobotsFetchInit = {}): RobotsFetch {
  const call = init.fetch ?? fetch;
  const limit = init.maxBytes ?? DEFAULT_ROBOTS_MAX_BYTES;
  return async (robotsUrl: string): Promise<string | undefined> => {
    // Armed per read, not per gate: the gate is long-lived and reads once per origin, so a
    // deadline created alongside it would already have expired by the second origin.
    const deadline = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_ROBOTS_TIMEOUT_MS);
    const signal = init.signal === undefined ? deadline : AbortSignal.any([deadline, init.signal]);
    try {
      const response = await call(robotsUrl, {
        signal,
        ...(init.proxy === undefined ? {} : { proxy: init.proxy }),
      } as RequestInit);
      if (!response.ok) return undefined;
      // Counted as it arrives rather than `.text()`, which materialises the whole body first: a
      // multi-gigabyte robots.txt is a heap the worker never gets back.
      const capped = await readWithinLimit(response.body, limit);
      return 'over' in capped ? undefined : new TextDecoder().decode(capped.bytes);
    } catch {
      return undefined;
    }
  };
}
