// Single responsibility: the HTTP half both remote purge drivers share — one POST with a
// deadline, the status → retryable table, and the batching a provider's per-request key cap
// forces. Kept apart from the drivers because "which failure can succeed unchanged" is one
// judgement, and two copies of it would drift into two answers for the same 429.

import { renderThrowable } from '@ultimat3/core';
import { CacheDriverUnavailableError, CachePurgeFailedError } from './errors';

/** Just the call. `typeof fetch` also carries `preconnect`, which no test double should have to. */
export type PurgeFetch = (input: string, init: RequestInit) => Promise<Response>;

/** A purge is behind the write, not in front of it: a slow CDN must not hold the fan-out open. */
export const DEFAULT_PURGE_TIMEOUT_MS = 10_000;

const MAX_DETAIL_LENGTH = 200;

// A 4xx here means the same request, unchanged, might land: a throttle or a momentary conflict.
// Every other 4xx is a credential or a plan, which no retry fixes. The table itself is
// `@ultimat3/core`'s — this line and `packages/mail/src/driver-resend.ts`'s were byte-identical in
// two packages that cannot import each other, so one of them was always going to be edited alone.
// Re-exported rather than imported twice, so both purge drivers still read "what a failure means"
// off the shared HTTP half — the same door `@ultimat3/auth`'s `tokens.ts` gives `timingSafeEqual`.
export { isRetryableStatus } from '@ultimat3/core';

/**
 * A bare reference to `globalThis.fetch` risks "Illegal invocation" on some hosts; closing over
 * the call keeps it detached from any receiver, in production and in tests alike.
 */
export const defaultPurgeFetch: PurgeFetch = (input, init) => globalThis.fetch(input, init);

/**
 * Providers cap keys per request. A bust of 300 tags is still one purge — several requests.
 *
 * The size is refused before the loop, not trusted: a `0` or a negative never advances `index`, so
 * the fan-out hangs holding the write's invalidation open, and a `NaN` ends the loop after one pass
 * that slices to nothing — an empty key list posted to a CDN that answers 200 and clears nothing.
 * `X_CACHE_DRIVER_UNAVAILABLE` rather than `X_CACHE_PURGE_FAILED`: the only sizes this ever sees
 * are the drivers' own caps, so a bad one is this package miswired, and no CDN refused anything.
 */
export function chunked<T>(
  driver: string,
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new CacheDriverUnavailableError({
      driver,
      cause: `batch size ${String(size)} is not a positive integer, so ${values.length} keys cannot be split into requests`,
      fix: 'pass a positive integer batch size to chunked(), as FASTLY_MAX_KEYS_PER_REQUEST does',
    });
  }
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

/**
 * A credential the driver cannot run without, refused at construction — where the env key is
 * still nameable — rather than on the first purge nobody watches. "no CDN token" is what
 * `X_CACHE_DRIVER_UNAVAILABLE` already means, so this is that code and not a second one.
 */
export function requireCredential(value: string, envKey: string, driver: string): string {
  if (value.trim() !== '') return value.trim();
  throw new CacheDriverUnavailableError({
    driver,
    cause: `${envKey} is unset, so the ${driver} purge driver has no credential`,
    fix: `set ${envKey} in .env.production, or use noopPurgeDriver() to purge nothing`,
  });
}

// Every CDN splits a key list on whitespace or a comma, so a key carrying either purges two
// things that do not exist instead of the one that does — silently, since the request succeeds.
const UNSAFE_KEY = /[\s,]/;
const MAX_KEY_LENGTH = 1024;

const keyProblem = (key: string): string | undefined => {
  if (key === '') return 'is empty';
  if (UNSAFE_KEY.test(key))
    return 'contains whitespace or a comma, which a CDN reads as a separator';
  if (key.length > MAX_KEY_LENGTH)
    return `is ${key.length} characters, over the 1024-byte key limit`;
  return undefined;
};

/**
 * Refused before the request, not after: a malformed key comes back as an accepted purge that
 * cleared nothing, which is the one CDN failure no later read can catch.
 */
export function assertPurgeableKeys(driver: string, keys: readonly string[]): void {
  for (const key of keys) {
    const problem = keyProblem(key);
    if (problem === undefined) continue;
    throw new CachePurgeFailedError({
      driver,
      detail: `surrogate key ${JSON.stringify(key)} ${problem}`,
      retryable: false,
      fix: 'rename the tag in its declareTags(...) call so the key carries no space or comma',
    });
  }
}

export interface PurgeBody {
  readonly text: string;
  /** `undefined` when the provider sent something that is not JSON — an html error page, or nothing. */
  readonly json: unknown;
}

/**
 * The body, read exactly once. A `Response` streams: `json()` followed by `text()` throws "Body
 * already used", so the failure path would lose the very message it exists to report.
 */
export async function purgeBody(response: Response): Promise<PurgeBody> {
  const text = await response.text().catch(() => '');
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text, json: undefined };
  }
}

/** Raw text, capped so a provider's error page cannot flood a log line. */
export function detailFrom(body: PurgeBody): string {
  if (body.text === '') return 'the response body was empty';
  return body.text.length > MAX_DETAIL_LENGTH
    ? `${body.text.slice(0, MAX_DETAIL_LENGTH)}…`
    : body.text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PurgePostInput {
  readonly driver: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly fetch: PurgeFetch;
  readonly timeoutMs: number;
}

/**
 * One POST, with the transport failure already translated. A request that never got a status —
 * DNS, TLS, a reset, the deadline — is retryable by definition: nothing at the edge has seen it.
 */
export async function purgePost(input: PurgePostInput): Promise<Response> {
  try {
    return await input.fetch(input.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...input.headers },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    // `renderThrowable`, never `error.message` behind an `instanceof`: `fetch` is INJECTED here,
    // so the rejection is whatever a driver or a test double threw — and `instanceof` itself
    // throws on a `Proxy` whose `getPrototypeOf` does, which would replace the coded refusal this
    // catch exists to raise with a bare `TypeError` from inside it. Same rule as `invalidate.ts`.
    const reason = renderThrowable(error);
    throw new CachePurgeFailedError({
      driver: input.driver,
      detail: `${reason} — nothing left this host for ${input.url} (egress, DNS or TLS)`,
      retryable: true,
      fix: `curl -sS -m 5 -o /dev/null ${input.url}`,
    });
  }
}
