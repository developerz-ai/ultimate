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
import { bodyTooLarge, hostBlocked, httpFailed, redirectLoop, scrapeTimeout } from './error-throws';
import type { RedirectHop } from './http-redirect';
import { MAX_REDIRECT_HOPS, redirectHop } from './http-redirect';
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
 * A hop's body is thrown away — nothing reads a redirect's — and an unread stream holds its socket
 * open until the collector gets to it. `cancel()` on a body that already errored rejects, and that
 * rejection is not this request's failure: the hop is over and the next one is what the caller is
 * waiting for.
 */
const discardHopBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Discarded bytes cannot fail a request.
  }
};

/**
 * The credentials a CALLER set, which are scoped to the origin they were set for — the platform's
 * own `follow` deleted these on a cross-origin hop (step 13 of the fetch standard's HTTP-redirect
 * fetch) and this file took the chain over, so this file owns the strip. `cookie` is here for the
 * hand-written header only: the jar's own value is computed per hop by `cookieHeaderFor`, which
 * has always been scoped to the host being dialled.
 */
const CROSS_ORIGIN_STRIPPED = new Set(['authorization', 'proxy-authorization', 'cookie']);

const withoutCredentials = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CROSS_ORIGIN_STRIPPED.has(name.toLowerCase())),
  );

/** Unparseable is not same-origin: a URL this package cannot read is one it cannot vouch for. */
const sameOrigin = (left: string, right: string): boolean => {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

/**
 * The final answer, read under the cap. Counted as it arrives rather than `.text()`, which
 * materialises first and checks never: a 30s stream at 50MB/s is a 1.5GB allocation the worker
 * does not get back, and it takes every other job on that worker with it. The same read
 * `robots-fetch.ts` performs.
 */
const readResponse = async (
  url: string,
  response: Response,
  maxBytes: number,
  secrets: ScrapeSecrets | undefined,
): Promise<ScrapeResponse> => {
  const capped = await readWithinLimit(response.body, maxBytes);
  if ('over' in capped) throw bodyTooLarge(url, capped.over, maxBytes);
  const body = new TextDecoder().decode(capped.bytes);
  return responseOver(
    url,
    response.status,
    headerRecord(response.headers),
    () => Promise.resolve(body),
    secrets,
  );
};

/**
 * The real transport. Every guarantee the page makes is re-applied here, in the same order and
 * through the same functions — `interceptVerdict` is the one host rule, `RobotsGate` is the one
 * robots rule, and neither is re-implemented for the second leg.
 *
 * REDIRECTS ARE FOLLOWED BY THIS FILE, hop by hop, and not by `fetch`. Until 2026-09 the call
 * carried the platform default `redirect: 'follow'`, so an allow-listed endpoint answering
 * `302 -> http://169.254.169.254/…` read the metadata service THROUGH the allow list: the three
 * gates above had all been asked about the URL the caller wrote, `res.url` and the network ring
 * both reported that URL, and nothing ever asked robots about where the body came from. The CDP
 * leg never had the hole — interception fires per hop there — and this file's header claims parity
 * with it.
 */
export function httpOverFetch(init: HttpTransportInit): ScrapeHttp {
  const call: ScrapeFetch = init.fetch ?? fetch;
  /**
   * The three gates, in one place, so the initial URL and hop seven are screened by the same code
   * in the same order. A second copy for redirects is how the two drift.
   */
  const screen = async (target: string): Promise<void> => {
    if (interceptVerdict(target, 'fetch', init.rules) !== 'allow') {
      throw hostBlocked(target, init.rules.allowHosts);
    }
    await init.robots?.assertAllowed(target);
    await init.pace?.(init.signal);
  };
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
      await screen(url);
      const session = await init.session();
      // `AbortSignal.timeout` and NOT `clock.sleep`: this is a deadline handed to the platform's
      // own fetch, not a wait this package performs — and under a test clock a slept deadline
      // would fire on the microtask after it was armed, cancelling every request instantly.
      // The offline transport (`http-recorded.ts`) is what a test runs, and it has no deadline.
      //
      // ONE deadline for the whole chain, not one per hop: the caller declared a budget for
      // getting an answer, and ten hops each allowed the full budget is ten times the wait.
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const signals = init.signal === undefined ? [deadlineSignal] : [deadlineSignal, init.signal];
      try {
        let hop: RedirectHop = {
          url,
          method: request.method ?? 'GET',
          body: request.body,
        };
        // Latched off at the first cross-origin hop and never back on: the fetch standard DELETES
        // the header from the request rather than re-deciding per hop, so `A -> B -> A` does not
        // hand A's bearer back on the way home.
        let credentialsInScope = true;
        for (let followed = 0; ; followed += 1) {
          // Per hop, because the jar is every domain the browser touched: a cookie computed for
          // the first host and re-sent to the second is the leak `cookie-scope.ts` exists to
          // prevent, arriving through the one door that never asked it twice.
          const cookies = cookieHeaderFor(session.cookies, hop.url);
          // Both header sources re-scoped the way the jar above already is, in the SAME precedence
          // they had before: an `authorization` minted for the first host was the one credential
          // that still rode along to wherever a `302` pointed.
          const carried = credentialsInScope
            ? session.headers
            : withoutCredentials(session.headers);
          const declared = credentialsInScope
            ? request.headers
            : withoutCredentials(request.headers ?? {});
          const response = await call(hop.url, {
            method: hop.method,
            headers: {
              ...carried,
              ...(session.userAgent === '' ? {} : { 'user-agent': session.userAgent }),
              ...(cookies === undefined ? {} : { cookie: cookies }),
              ...declared,
            },
            ...(hop.body === undefined ? {} : { body: hop.body }),
            signal: AbortSignal.any(signals),
            // The whole point: the platform's own `follow` is what made the four lines above
            // decorative, because it dials the target itself and hands back one Response.
            redirect: 'manual',
            ...(init.proxy === undefined ? {} : { proxy: init.proxy }),
          });
          // The URL that was REQUESTED, hop by hop. A chain reported under the caller's URL sends
          // its reader hunting for a request the site never answered.
          init.network.push({
            method: hop.method,
            url: hop.url,
            status: response.status,
            resourceType: 'fetch',
            at: init.clock.now().getTime(),
          });
          const next = redirectHop(
            response.status,
            response.headers.get('location'),
            hop.url,
            hop.method,
            hop.body,
          );
          if (next === undefined)
            return await readResponse(hop.url, response, maxBytes, init.secrets);
          // Discarded BEFORE the refusal, not after it: a throw over an unread stream holds that
          // hop's socket until the collector reaches it, and the refusal path is exactly the one a
          // hostile chain drives ten times per request.
          await discardHopBody(response);
          if (followed >= MAX_REDIRECT_HOPS) throw redirectLoop(url, next.url, followed + 1);
          init.onActivity?.();
          await screen(next.url);
          if (!sameOrigin(hop.url, next.url)) credentialsInScope = false;
          hop = next;
        }
      } catch (thrown) {
        // A deadline that fired is this package's own timeout, with its own code and fix — never
        // the platform's bare `TimeoutError` reaching a job's retry classifier unclassified.
        if (deadlineSignal.aborted) throw scrapeTimeout(`http ${url}`, timeoutMs);
        throw thrown;
      }
    },
  };
}
