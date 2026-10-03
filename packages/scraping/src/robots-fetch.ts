// The ONE `/robots.txt` read the gate performs when the caller injects no `fetchText`.
//
// It exists as its own file because the production default was the only network call in this
// package with no deadline, no size cap and no proxy — and `scrape-run.ts` builds the gate with no
// `fetchText`, so production always took it. Every existing gate test injected one, which is how a
// read that could park a run forever stayed green.
//
// The exit is a RESOLVER, not a string: `scrape-run.ts` builds this gate as an argument to
// `driver.open()`, and the proxy is a driver option the session only reports on the way back out.

import { finiteCount, readWithinLimit } from '@ultimat3/core';
import type { HostRule } from './hosts';
import type { ScrapeFetch } from './http';
import { redirectHop } from './http-redirect';
import { interceptVerdict } from './intercept';
import type { HostResolve } from './pinned-host';
import { dialTarget, resolveHost } from './pinned-host';
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

/** RFC 9309 §2.3.1.2: a crawler SHOULD follow at least five consecutive redirects for robots.txt. */
export const MAX_ROBOTS_REDIRECTS = 5;

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
   * The run's `allowHosts`, asked about EVERY hop — the first URL included — through
   * `interceptVerdict`, the one host rule. A hop off the list is never requested and the read
   * answers "no robots". With none given, only a redirect that stays on the starting HOSTNAME is
   * followed (a scheme upgrade, a moved path), still capped; another host is never dialled.
   */
  readonly allowHosts?: readonly HostRule[] | undefined;
  /** The resolver a wildcard-admitted name is checked and pinned with. Defaults to `Bun.dns`. */
  readonly resolve?: HostResolve | undefined;
  /**
   * The platform `fetch`, injectable so the default path itself is testable. `ScrapeFetch` and not
   * `typeof fetch`: the latter also carries `preconnect`, so nothing a caller can write satisfies
   * it and the option was reachable only through a cast.
   */
  readonly fetch?: ScrapeFetch | undefined;
}

const onList = (url: string, allowHosts: readonly HostRule[]): boolean =>
  interceptVerdict(url, 'fetch', { allowHosts }) === 'allow';

/** Same hostname over http(s) — the port may change with the scheme. Unparseable is not same. */
const sameHost = (from: string, to: string): boolean => {
  try {
    const next = new URL(to);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return false;
    return new URL(from).hostname === next.hostname;
  } catch {
    return false;
  }
};

/** The final hop's body under the cap, or `undefined` for a non-2xx answer. */
const answerOf = async (response: Response, limit: number): Promise<string | undefined> => {
  if (!response.ok) return undefined;
  // Counted as it arrives rather than `.text()`, which materialises the whole body first: a
  // multi-gigabyte robots.txt is a heap the worker never gets back.
  const capped = await readWithinLimit(response.body, limit);
  return 'over' in capped ? undefined : new TextDecoder().decode(capped.bytes);
};

/**
 * Reads `robotsUrl`, or answers `undefined` — which the gate reads as "no restrictions", the
 * standard's own answer for a file it cannot obtain. A deadline that fires, a body past the cap,
 * a 404 and a redirect off `allowHosts` are all the same answer on purpose: none of them is
 * evidence of a rule.
 */
export function robotsFetcher(init: RobotsFetchInit = {}): RobotsFetch {
  const call: ScrapeFetch = init.fetch ?? fetch;
  const resolve = init.resolve ?? resolveHost;
  // Both bounds are screened HERE, at construction, and both floors are 1 — because every way this
  // read can fail is the same answer, `undefined`, which the gate reads as "no restrictions". A
  // `NaN` deadline throws a bare `TypeError` out of `AbortSignal.timeout` (measured: "Value NaN is
  // outside the range [0, 9007199254740991]") straight into the gate's own `.catch`, and a `NaN`
  // cap makes `readWithinLimit` refuse after the request already left. A zero of either is the
  // same outcome spelled deliberately: an expired deadline and a cap every file is over. Robots
  // enforcement off, for the whole run, with nothing in the log.
  const limit = finiteCount(
    'robotsFetcher',
    'maxBytes',
    init.maxBytes ?? DEFAULT_ROBOTS_MAX_BYTES,
    1,
  );
  const timeoutMs = finiteCount(
    'robotsFetcher',
    'timeoutMs',
    init.timeoutMs ?? DEFAULT_ROBOTS_TIMEOUT_MS,
    1,
  );
  return async (robotsUrl: string): Promise<string | undefined> => {
    // Armed per read, not per gate: the gate is long-lived and reads once per origin, so a
    // deadline created alongside it would already have expired by the second origin.
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal === undefined ? deadline : AbortSignal.any([deadline, init.signal]);
    // Resolved here, at the read, because the session that owns the exit did not exist when this
    // fetcher was built. An empty string is not an exit and is dropped with the absent one.
    const proxy = init.proxy?.();
    const dialled = proxy === undefined || proxy === '' ? undefined : proxy;
    try {
      let url = robotsUrl;
      for (let hops = 0; ; hops += 1) {
        if (init.allowHosts !== undefined && !onList(url, init.allowHosts)) return undefined;
        // Pinned exactly as the HTTP leg pins (`pinned-host.ts`), and for its reason skipped
        // through a proxy. A name resolving inward throws, which this read answers as "no robots".
        const dial =
          init.allowHosts === undefined || dialled !== undefined
            ? { url }
            : await dialTarget(url, init.allowHosts, resolve);
        // `manual`, never the platform default: `follow` dials wherever the site points before
        // anything here can ask whether that host is on the list.
        const response = await call(dial.url, {
          signal,
          redirect: 'manual',
          ...(dialled === undefined ? {} : { proxy: dialled }),
          ...(dial.host === undefined ? {} : { headers: { host: dial.host } }),
          ...(dial.serverName === undefined ? {} : { tls: { serverName: dial.serverName } }),
        });
        const next = redirectHop(
          response.status,
          response.headers.get('location'),
          url,
          'GET',
          undefined,
        );
        if (next === undefined) return await answerOf(response, limit);
        await response.body?.cancel().catch(() => undefined);
        if (hops >= MAX_ROBOTS_REDIRECTS) return undefined;
        // With no list to ask, only a hop that stays on the host the read started on is
        // followed — an `http:` → `https:` upgrade or a moved path. Another host is a host
        // nobody screened, and is never dialled.
        if (init.allowHosts === undefined && !sameHost(robotsUrl, next.url)) return undefined;
        url = next.url;
      }
    } catch {
      return undefined;
    }
  };
}
