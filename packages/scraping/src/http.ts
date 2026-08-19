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

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse } from '@ultimat3/schema';
import type { ScrapeClock } from './clock';
import { cookieHeaderFor } from './cookie-scope';
import { hostBlocked, httpFailed, scrapeTimeout } from './error-throws';
import type { InterceptRules } from './intercept';
import { interceptVerdict } from './intercept';
import type { NetworkRing } from './rings';
import type { RobotsGate } from './robots';
import type { SessionSnapshot } from './session-state';

export interface HttpRequestInit {
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** Milliseconds. Falls back to the session's own default. */
  readonly timeout?: number | undefined;
}

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
  readonly fetch?: typeof fetch | undefined;
}

const headerRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

export function responseOver(
  url: string,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: () => Promise<string>,
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
      if (!ok) throw httpFailed(url, status, (await text()).slice(0, 200));
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
  const call = init.fetch ?? fetch;
  return {
    async request(url: string, request: HttpRequestInit = {}): Promise<ScrapeResponse> {
      init.onActivity?.();
      if (interceptVerdict(url, 'fetch', init.rules) !== 'allow') {
        throw hostBlocked(url, init.rules.allowHosts);
      }
      await init.robots?.assertAllowed(url);
      await init.pace?.(init.signal);
      const session = await init.session();
      const cookies = cookieHeaderFor(session.cookies, url);
      const timeoutMs = request.timeout ?? init.timeoutMs;
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
        } as RequestInit);
        init.network.push({
          method: request.method ?? 'GET',
          url,
          status: response.status,
          resourceType: 'fetch',
          at: init.clock.now().getTime(),
        });
        const body = await response.text();
        return responseOver(url, response.status, headerRecord(response.headers), () =>
          Promise.resolve(body),
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
