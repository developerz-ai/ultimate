// The second transport, and the one that makes a scraper fast: drive the BROWSER through login,
// 2FA and navigation, then reverse-engineer the site's own JSON endpoints and pull the bulk over
// plain HTTP. Two hundred paginated pages clicked through is minutes and a hundred chances to
// break; the same data off the endpoint behind them is seconds, and a JSON endpoint changes far
// less often than a DOM.
//
// It is SESSION-BOUND, never a bare `fetch`. The browser's cookies, the browser's headers, the
// browser's proxy, the same `allowHosts`, the same robots gate, the same rate limit, the same
// cancellation. A second transport that quietly had none of those would be a hole in every
// guarantee the page vocabulary makes — and a different exit IP mid-session is exactly what
// anti-bot systems look for.

import { finiteCount, readWithinLimit } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse } from '@ultimat3/schema';
import type { ScrapeClock } from './clock';
import { cookieHeaderFor } from './cookie-scope';
import { bodyTooLarge, hostBlocked, httpFailed, scrapeTimeout } from './error-throws';
import type { InterceptRules } from './intercept';
import { interceptVerdict } from './intercept';
import type { NetworkRing } from './rings';
import type { RobotsGate } from './robots';
import type { ScrapeSecrets } from './secrets';
import { redactSecrets } from './secrets';
import type { SessionSnapshot } from './session-state';

/**
 * Just the call. `typeof fetch` also carries `preconnect`, which no test double and no app wrapper
 * can supply — so an option typed `typeof fetch` was unusable without a double cast, which is
 * exactly what every caller of it had written. The same seam `@ultimat3/cache`, `@ultimat3/auth`
 * and `@ultimat3/mail` already name.
 */
export type ScrapeFetch = (input: string, init: ScrapeFetchInit) => Promise<Response>;

/**
 * `RequestInit` plus the one Bun extension this package sets. Named rather than cast: the DOM's
 * `RequestInit` has no `proxy`, and an `as RequestInit` over the literal silenced the excess-key
 * check for `proxy` AND for every neighbouring key it was standing next to.
 */
export interface ScrapeFetchInit extends RequestInit {
  /** The session's exit. A different exit IP mid-session is a different client to an anti-bot. */
  readonly proxy?: string | undefined;
}

export interface HttpRequestInit {
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** Milliseconds. Falls back to the session's own default. */
  readonly timeout?: number | undefined;
  /**
   * Response-body ceiling in bytes. Falls back to `DEFAULT_HTTP_MAX_BYTES`. Never absent: a
   * deadline bounds time and a scraped endpoint is somebody else's, so the only thing standing
   * between a hostile stream and the worker's heap is a number.
   */
  readonly maxBytes?: number | undefined;
}

/**
 * Generous for the JSON endpoint behind a paginated page — the reason this transport exists — and
 * far under what OOM-kills a worker. Raised per call with `{ maxBytes }`, never globally: a run
 * that genuinely pulls a large export says so at the call site that pulls it.
 */
export const DEFAULT_HTTP_MAX_BYTES = 32 * 1024 * 1024;

export interface ScrapeResponse {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
  /** `unknown`, always. A response body is somebody else's JSON until a schema says otherwise. */
  json(): Promise<unknown>;
  /**
   * Parse-or-throw, and the blessed path: a non-2xx answer is `X_SCRAPE_HTTP_FAILED` before the
   * schema ever runs, so "the endpoint moved" never arrives as "the schema is wrong".
   */
  parse<T>(schema: StandardSchemaV1<unknown, T>): Promise<T>;
}

export interface ScrapeHttp {
  /** One method. `get`/`post` sugar would be a second way to do the same thing (axiom 1). */
  request(url: string, init?: HttpRequestInit): Promise<ScrapeResponse>;
}

export interface HttpTransportInit {
  readonly rules: InterceptRules;
  readonly clock: ScrapeClock;
  readonly timeoutMs: number;
  readonly network: NetworkRing;
  /**
   * Read fresh on every request, and asynchronously because reading a real browser's jar is a
   * round trip. A snapshot captured when the session opened would be the LOGGED-OUT one forever,
   * which is precisely the handoff this transport exists to make.
   */
  session(): Promise<SessionSnapshot>;
  readonly robots?: RobotsGate | undefined;
  readonly pace?: ((signal?: AbortSignal) => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onActivity?: (() => void) | undefined;
  /** The SAME proxy the browser dialled through. A different exit IP is a different client. */
  readonly proxy?: string | undefined;
  /**
   * The run's secret bag, for the ONE thing this leg persists that the site wrote: the first 200
   * bytes of a non-2xx body, in `X_SCRAPE_HTTP_FAILED`'s cause. A login endpoint that echoes the
   * submitted credential in its 4xx body put a password in an `UltimateError.message`, which the
   * job driver writes to the dead-letter row and `x jobs show` prints. This field did not exist
   * until 2026-08-24, so nothing on this leg COULD redact.
   */
  readonly secrets?: ScrapeSecrets | undefined;
  readonly fetch?: ScrapeFetch | undefined;
}

/**
 * Response headers as data, on a NULL prototype and written with `defineProperty`.
 *
 * The header set on a scraping leg is entirely the site's. `out[key] = value` on a plain object
 * DROPS `__proto__` — a legal HTTP field-name token — because the setter it hits refuses a string
 * and files no own key, and it leaves `headers['toString']` answering a function the site never
 * sent. Both make `Readonly<Record<string, string>>` a lie the caller cannot see through.
 */
const headerRecord = (headers: Headers): Record<string, string> => {
  const out = Object.create(null) as Record<string, string>;
  headers.forEach((value, key) => {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return out;
};

/**
 * `secrets` is optional and last so every existing caller compiles — but a caller that HAS a bag
 * and omits it is a caller whose refusal quotes the site verbatim, which is exactly the defect.
 * Both transports pass it: `httpOverFetch` from the driver's `SessionInit`, `recordedHttp` from
 * the offline session's, so a fixture proves the redaction the live leg performs.
 */
export function responseOver(
  url: string,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: () => Promise<string>,
  secrets?: ScrapeSecrets | undefined,
): ScrapeResponse {
  const ok = status >= 200 && status < 300;
  const text = body;
  return {
    url,
    status,
    ok,
    headers,
    text,
    json: async (): Promise<unknown> => JSON.parse(await text()) as unknown,
    async parse<T>(schema: StandardSchemaV1<unknown, T>): Promise<T> {
      // Redacted BEFORE the slice, never after: cutting at 200 bytes can leave half a secret,
      // and half a password is still half a password in a durable row.
      if (!ok) throw httpFailed(url, status, redactSecrets(await text(), secrets).slice(0, 200));
      return parse(schema, JSON.parse(await text()) as unknown);
    },
  };
}

/**
 * The real transport. Every guarantee the page makes is re-applied here, in the same order and
 * through the same functions — `interceptVerdict` is the one host rule, `RobotsGate` is the one
 * robots rule, and neither is re-implemented for the second leg.
 */
export function httpOverFetch(init: HttpTransportInit): ScrapeHttp {
  const call: ScrapeFetch = init.fetch ?? fetch;
  return {
    async request(url: string, request: HttpRequestInit = {}): Promise<ScrapeResponse> {
      // Screened FIRST — before the activity touch, before the robots read this method performs
      // and before a byte leaves. `AbortSignal.timeout(NaN)` THROWS, and it throws a bare
      // `TypeError` ("Value NaN is outside the range [0, 9007199254740991]"), which is the one
      // thing the deadline below exists to prevent: an unclassified platform error reaching a
      // job's retry classifier instead of this package's own `X_SCRAPE_TIMEOUT`. And the cap is
      // the only thing between a hostile stream and the worker's heap, so `readWithinLimit`'s own
      // refusal is too late: it arrives once the request — a POST included — has been performed.
      //
      // Both floors are 1. A zero deadline aborts on the tick it is armed and a zero cap puts
      // every response over, so either one makes every request on this leg fail; neither is a
      // caller declining a feature the way `watchdog.graceMs: 0` is.
      const timeoutMs = finiteCount(
        'http.request',
        'timeout',
        request.timeout ?? init.timeoutMs,
        1,
      );
      const maxBytes = finiteCount(
        'http.request',
        'maxBytes',
        request.maxBytes ?? DEFAULT_HTTP_MAX_BYTES,
        1,
      );
      init.onActivity?.();
      if (interceptVerdict(url, 'fetch', init.rules) !== 'allow') {
        throw hostBlocked(url, init.rules.allowHosts);
      }
      await init.robots?.assertAllowed(url);
      await init.pace?.(init.signal);
      const session = await init.session();
      const cookies = cookieHeaderFor(session.cookies, url);
      // `AbortSignal.timeout` and NOT `clock.sleep`: this is a deadline handed to the platform's
      // own fetch, not a wait this package performs — and under a test clock a slept deadline
      // would fire on the microtask after it was armed, cancelling every request instantly.
      // The offline transport (`http-recorded.ts`) is what a test runs, and it has no deadline.
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const signals = init.signal === undefined ? [deadlineSignal] : [deadlineSignal, init.signal];
      try {
        const response = await call(url, {
          method: request.method ?? 'GET',
          headers: {
            ...session.headers,
            ...(session.userAgent === '' ? {} : { 'user-agent': session.userAgent }),
            ...(cookies === undefined ? {} : { cookie: cookies }),
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: AbortSignal.any(signals),
          ...(init.proxy === undefined ? {} : { proxy: init.proxy }),
        });
        init.network.push({
          method: request.method ?? 'GET',
          url,
          status: response.status,
          resourceType: 'fetch',
          at: init.clock.now().getTime(),
        });
        // Counted as it arrives rather than `.text()`, which materialises first and checks never:
        // a 30s stream at 50MB/s is a 1.5GB allocation the worker does not get back, and it takes
        // every other job on that worker with it. The same read `robots-fetch.ts` performs.
        const capped = await readWithinLimit(response.body, maxBytes);
        if ('over' in capped) throw bodyTooLarge(url, capped.over, maxBytes);
        const body = new TextDecoder().decode(capped.bytes);
        return responseOver(
          url,
          response.status,
          headerRecord(response.headers),
          () => Promise.resolve(body),
          init.secrets,
        );
      } catch (thrown) {
        // A deadline that fired is this package's own timeout, with its own code and fix — never
        // the platform's bare `TimeoutError` reaching a job's retry classifier unclassified.
        if (deadlineSignal.aborted) throw scrapeTimeout(`http ${url}`, timeoutMs);
        throw thrown;
      }
    },
  };
}
