// Single responsibility: Cloudflare's cache-tag purge. One `POST /zones/<id>/purge_cache` per
// batch of tags, the same call with `purge_everything` for the whole zone. Cloudflare's cache
// tags ARE Ultimate's wire tags, so a `Cache-Tag` response header and an `invalidates: [tag.post]`
// name the same string — the alternative, purging by URL, would need a route list nobody keeps.

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
  purgeBody,
  purgePost,
  requireCredential,
} from './purge-http';
import { assertFiniteDurationMs } from './tiers';

export const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

/** Cloudflare takes 30 cache tags per purge call; a longer list is more requests, not a refusal. */
export const CLOUDFLARE_MAX_TAGS_PER_REQUEST = 30;

export interface CloudflarePurgeOptions {
  /** Read from `CLOUDFLARE_API_TOKEN`; needs the zone "Cache Purge" permission. */
  readonly apiToken: string;
  /** Read from `CLOUDFLARE_ZONE_ID` — the zone this deployment is served from. */
  readonly zoneId: string;
  /** Override for a proxy or a test double. Defaults to `CLOUDFLARE_API_URL`. */
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: PurgeFetch | undefined;
}

// Every branch names the env key to edit, the call to narrow, or a command to run. The 429 named
// none of them: the ceiling is per zone and not raisable from here, so the only lever is the
// `invalidates` list that decides how many 30-tag requests one write sends. `retryable` already
// says the same purge can land — the fix is what stops the next write hitting the wall again.
const fixFor = (status: number): string => {
  if (status === 401 || status === 403) {
    return 'set CLOUDFLARE_API_TOKEN in .env.production to a token holding the zone "Cache Purge" permission';
  }
  if (status === 400) {
    return 'unset CLOUDFLARE_API_TOKEN in .env.production to purge nothing — purge by cache tag needs an Enterprise zone';
  }
  if (status === 404) {
    return 'set CLOUDFLARE_ZONE_ID in .env.production to the zone id on the Cloudflare dashboard overview page';
  }
  if (status === 429) {
    return "narrow the action's cache.invalidates to fewer tag(...) entries — the zone allows 1000 purge calls per minute";
  }
  return 'curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID';
};

/** Cloudflare's own errors, when it sent any: `{"errors":[{"code":1122,"message":"…"}]}`. */
function messagesFrom(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const errors = payload['errors'];
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const messages = errors
    .map((entry) =>
      isRecord(entry) && typeof entry['message'] === 'string' ? entry['message'] : undefined,
    )
    .filter((message): message is string => message !== undefined);
  return messages.length > 0 ? messages.join('; ') : undefined;
}

export function cloudflarePurgeDriver(options: CloudflarePurgeOptions): PurgeDriver {
  const apiToken = requireCredential(options.apiToken, 'CLOUDFLARE_API_TOKEN', 'cloudflare');
  const zoneId = requireCredential(options.zoneId, 'CLOUDFLARE_ZONE_ID', 'cloudflare');
  const baseUrl = options.baseUrl ?? CLOUDFLARE_API_URL;
  const timeoutMs = assertFiniteDurationMs(
    'cloudflare',
    'timeoutMs',
    options.timeoutMs ?? DEFAULT_PURGE_TIMEOUT_MS,
  );
  const doFetch = options.fetch ?? defaultPurgeFetch;
  const headers = { Authorization: `Bearer ${apiToken}` };

  const post = (body: unknown): Promise<Response> =>
    purgePost({
      driver: 'cloudflare',
      url: `${baseUrl}/zones/${zoneId}/purge_cache`,
      headers,
      body,
      fetch: doFetch,
      timeoutMs,
    });

  /**
   * Cloudflare answers a refusal with HTTP 200 and `"success": false`, so `response.ok` alone
   * would read a rejected purge as a completed one and leave the edge stale with no failure
   * anywhere. Both halves are checked, and only here.
   */
  const settle = async (response: Response): Promise<void> => {
    const body = await purgeBody(response);
    if (!response.ok) {
      throw new CachePurgeFailedError({
        driver: 'cloudflare',
        detail: messagesFrom(body.json) ?? detailFrom(body),
        status: response.status,
        retryable: isRetryableStatus(response.status),
        fix: fixFor(response.status),
      });
    }
    if (isRecord(body.json) && body.json['success'] === false) {
      throw new CachePurgeFailedError({
        driver: 'cloudflare',
        detail:
          messagesFrom(body.json) ?? 'the api answered 200 with success: false and no message',
        status: response.status,
        retryable: false,
        fix: fixFor(400),
      });
    }
  };

  return {
    name: 'cloudflare',

    async purge(keys: readonly string[]): Promise<readonly string[]> {
      if (keys.length === 0) return [];
      assertPurgeableKeys('cloudflare', keys);
      const accepted: string[] = [];
      // Sequential on purpose: the zone rate-limits purges, and nothing downstream reads a
      // purge before it lands, so parallelism would buy latency the caller never waits on.
      for (const batch of chunked('cloudflare', keys, CLOUDFLARE_MAX_TAGS_PER_REQUEST)) {
        await settle(await post({ tags: batch }));
        accepted.push(...batch);
      }
      return accepted;
    },

    async purgeAll(): Promise<void> {
      await settle(await post({ purge_everything: true }));
    },
  };
}
