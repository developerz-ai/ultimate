// Single responsibility: a presented API key → who is calling, in the shape a bearer mount and an
// MCP endpoint both take as `resolveToken`. `verifyApiKey` answers a record or throws; this is the
// one place that turns its ONE rejection into the `null` those surfaces answer 401 for — and
// leaves everything else a throw, because "the database is down" is not "your key is wrong".

import { type Clock, isUltimateError, systemClock } from '@ultimat3/core';
import type { ApiKeyStore } from './adapter';
import { apiKeyActor, verifyApiKey } from './api-keys';
import type { PolicyActor } from './policy-bridge';

/**
 * What a verified key resolves to. Structurally `@ultimat3/http`'s `BearerCaller` and
 * `@ultimat3/mcp`'s `ResolvedToken` — declared here because this tier can import neither.
 */
export interface ApiKeyCaller {
  /** The agent actor: the key's org, and its scopes as the permissions a policy reads. */
  readonly actor: PolicyActor;
  /** The key's scopes — what the mount's scope map is cut by. */
  readonly scopes: ReadonlySet<string>;
}

export interface ApiKeyResolverOptions {
  readonly clock?: Clock | undefined;
}

/**
 * `resolveToken: apiKeyResolver(() => keys)` on `defineApi({ http: { mounts } })` and on
 * `defineAppMcp()` — one resolver for both.
 *
 * `store` is a THUNK, read when a token is presented and never captured: a mount is declared when
 * its module is evaluated, and `new BuiltinAdapter()` takes the process's database client, which
 * boot installs later. `() => new MemoryAdapter()` would be a new, empty store per request — hold
 * the instance and return it.
 */
export function apiKeyResolver(
  store: () => ApiKeyStore,
  options: ApiKeyResolverOptions = {},
): (token: string) => Promise<ApiKeyCaller | null> {
  return async (token) => {
    try {
      const record = await verifyApiKey(store(), token, options.clock ?? systemClock);
      return { actor: apiKeyActor(record), scopes: new Set(record.scopes) };
    } catch (thrown) {
      // Every way a key can be wrong is this one code, by `verifyApiKey`'s own design: a caller
      // that could tell "revoked" from "unknown" could enumerate ids.
      if (isUltimateError(thrown) && thrown.code === 'X_API_KEY_INVALID') return null;
      throw thrown;
    }
  };
}
