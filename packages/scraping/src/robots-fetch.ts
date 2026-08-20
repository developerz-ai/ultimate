// The ONE `/robots.txt` read the gate performs when the caller injects no `fetchText`.
//
// It exists as its own file because the production default was the only network call in this
// package with no deadline, no size cap and no proxy — and `scrape-run.ts` builds the gate with no
// `fetchText`, so production always took it. Every existing gate test injected one, which is how a
// read that could park a run forever stayed green.
//
// The exit is a RESOLVER, not a string: `scrape-run.ts` builds this gate as an argument to
// `driver.open()`, and the proxy is a driver option the session only reports on the way back out.

import { readWithinLimit } from '@ultimat3/core';
import type { ScrapeFetch } from './http';
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
   * The SAME proxy the browser dialled through, when the session has one — asked PER READ, never
   * captured. A resolver rather than a string because construction order forbids the string: the
   * gate is an argument to `driver.open()` and the proxy is a driver option resolved inside it,
   * so a value passed here could only ever be the one nobody has yet. That is how the robots read
   * came to exit from the worker's IP while every page load exited through the proxy — and how an
   * origin reachable ONLY through the proxy read as "no robots.txt", which is allow-everything.
   *
   * Optional by design: proxies are an opt-in leg, and an origin reachable directly must still be
   * asked for its rules.
   */
  readonly proxy?: (() => string | undefined) | undefined;
  readonly maxBytes?: number | undefined;
  /**
   * The platform `fetch`, injectable so the default path itself is testable. `ScrapeFetch` and not
   * `typeof fetch`: the latter also carries `preconnect`, so nothing a caller can write satisfies
   * it and the option was reachable only through a cast.
   */
  readonly fetch?: ScrapeFetch | undefined;
}

/**
 * Reads `robotsUrl`, or answers `undefined` — which the gate reads as "no restrictions", the
 * standard's own answer for a file it cannot obtain. A deadline that fires, a body past the cap
 * and a 404 are all the same answer on purpose: none of them is evidence of a rule.
 */
export function robotsFetcher(init: RobotsFetchInit = {}): RobotsFetch {
  const call: ScrapeFetch = init.fetch ?? fetch;
  const limit = init.maxBytes ?? DEFAULT_ROBOTS_MAX_BYTES;
  return async (robotsUrl: string): Promise<string | undefined> => {
    // Armed per read, not per gate: the gate is long-lived and reads once per origin, so a
    // deadline created alongside it would already have expired by the second origin.
    const deadline = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_ROBOTS_TIMEOUT_MS);
    const signal = init.signal === undefined ? deadline : AbortSignal.any([deadline, init.signal]);
    // Resolved here, at the read, because the session that owns the exit did not exist when this
    // fetcher was built. An empty string is not an exit and is dropped with the absent one.
    const proxy = init.proxy?.();
    try {
      const response = await call(robotsUrl, {
        signal,
        ...(proxy === undefined || proxy === '' ? {} : { proxy }),
      });
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
