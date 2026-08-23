// Single responsibility: Fastly's surrogate-key purge. One `POST /service/<id>/purge` per batch
// of keys, one `POST /service/<id>/purge_all` for the whole service — no SDK, `fetch` is the whole
// client. The keys are Ultimate's wire tags unchanged (`post`, `post:1`), which is the property
// that keeps an edge purge and an app-level invalidation from ever meaning different things.

import type { PurgeDriver } from './cdn';
import { CachePurgeFailedError } from './errors';
import type { PurgeFetch } from './purge-http';
import {
  assertPurgeableKeys,
  chunked,
  DEFAULT_PURGE_TIMEOUT_MS,
  defaultPurgeFetch,
  detailFrom,
  isRecord,
  isRetryableStatus,
  type PurgeBody,
  purgeBody,
  purgePost,
  requireCredential,
} from './purge-http';

export const FASTLY_API_URL = 'https://api.fastly.com';

/** Fastly accepts 256 surrogate keys in one batch purge; more is a second request, not a refusal. */
export const FASTLY_MAX_KEYS_PER_REQUEST = 256;

export interface FastlyPurgeOptions {
  /** Read from `FASTLY_API_TOKEN`. A literal token in app.config.ts is a token in git. */
  readonly apiToken: string;
  /** Read from `FASTLY_SERVICE_ID` — which service this deployment fronts. */
  readonly serviceId: string;
  /** Override for a proxy or a test double. Defaults to `FASTLY_API_URL`. */
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: PurgeFetch | undefined;
}

// Every branch names the env key to edit or a command to run. "raise the rate limit, or bust fewer
// tags" was the one that named neither: Fastly answers every API call with `Fastly-RateLimit-*`,
// so the remaining budget and its reset are readable — which is the half an agent can act on.
const fixFor = (status: number): string => {
  if (status === 401 || status === 403) {
    return 'set FASTLY_API_TOKEN in .env.production to a token with the purge scope from https://manage.fastly.com/account/personal/tokens';
  }
  if (status === 404) {
    return 'set FASTLY_SERVICE_ID in .env.production to the id at https://manage.fastly.com/configure/services';
  }
  if (status === 429) {
    return 'curl -sS -D - -o /dev/null -H "Fastly-Key: $FASTLY_API_TOKEN" https://api.fastly.com/service/$FASTLY_SERVICE_ID | grep -i fastly-ratelimit';
  }
  return 'curl -sS -H "Fastly-Key: $FASTLY_API_TOKEN" https://api.fastly.com/service/$FASTLY_SERVICE_ID';
};

/**
 * Fastly answers a batch purge with `{ "<key>": "<purge id>" }`, and a single-key purge with
 * `{ "status": "ok", "id": … }`. Only the first shape names keys, so anything else is read as
 * "the whole batch was accepted" — which a 2xx already means.
 */
function acceptedFrom(body: PurgeBody, batch: readonly string[]): string[] {
  const payload = body.json;
  if (!isRecord(payload)) return [...batch];
  // `Object.hasOwn`, never `in`: a surrogate key named `constructor` or `toString` answered `true`
  // out of a body that never mentioned it, so `InvalidationReport.tiers` listed keys nothing had
  // purged — a partial bust reading as a clean one.
  const named = batch.filter((key) => Object.hasOwn(payload, key));
  return named.length > 0 ? named : [...batch];
}

export function fastlyPurgeDriver(options: FastlyPurgeOptions): PurgeDriver {
  const apiToken = requireCredential(options.apiToken, 'FASTLY_API_TOKEN', 'fastly');
  const serviceId = requireCredential(options.serviceId, 'FASTLY_SERVICE_ID', 'fastly');
  const baseUrl = options.baseUrl ?? FASTLY_API_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PURGE_TIMEOUT_MS;
  const doFetch = options.fetch ?? defaultPurgeFetch;
  const headers = { 'Fastly-Key': apiToken };

  const post = (path: string, body: unknown): Promise<Response> =>
    purgePost({
      driver: 'fastly',
      url: `${baseUrl}/service/${serviceId}${path}`,
      headers,
      body,
      fetch: doFetch,
      timeoutMs,
    });

  /** The body is read here whether or not the call failed, because a `Response` gives it up once. */
  const settle = async (response: Response): Promise<PurgeBody> => {
    const body = await purgeBody(response);
    if (response.ok) return body;
    throw new CachePurgeFailedError({
      driver: 'fastly',
      detail: detailFrom(body),
      status: response.status,
      retryable: isRetryableStatus(response.status),
      fix: fixFor(response.status),
    });
  };

  return {
    name: 'fastly',

    async purge(keys: readonly string[]): Promise<readonly string[]> {
      if (keys.length === 0) return [];
      assertPurgeableKeys('fastly', keys);
      const accepted: string[] = [];
      // Sequential on purpose: a bust of thousands of keys must not open thousands of sockets
      // against an API that rate-limits, and nothing downstream reads a purge before it lands.
      for (const batch of chunked('fastly', keys, FASTLY_MAX_KEYS_PER_REQUEST)) {
        const body = await settle(await post('/purge', { surrogate_keys: batch }));
        accepted.push(...acceptedFrom(body, batch));
      }
      return accepted;
    },

    async purgeAll(): Promise<void> {
      await settle(await post('/purge_all', {}));
    },
  };
}
