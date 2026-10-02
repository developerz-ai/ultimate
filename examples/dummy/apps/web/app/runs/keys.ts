/**
 * A machine caller's credential for the run actions. No second API — the `/v1` mount
 * (`api/index.ts`) re-serves the actions a browser calls, behind `resolveRunKey`.
 *
 * A key's scopes ARE its permissions (`apiKeyActor`), so a key issued with `run:write` passes
 * `canRunWrite` for the org it was issued in and for nothing else.
 */

import type { ApiKeyStore } from '@ultimat3/auth';
import {
  apiKeyResolver,
  BuiltinAdapter,
  issueApiKey,
  MemoryAdapter,
  revokeApiKey,
} from '@ultimat3/auth';
import { type Clock, resolveEnvironment } from '@ultimat3/core';

/** What a run key may do, and the one map the mount cuts its routes by. */
export const RUN_KEY_SCOPES = {
  'run:write': ['startRun', 'answerPrompt', 'cancelRun'],
  'run:read': ['liveRunEvents'],
} as const;

/**
 * `x_api_keys` through the framework's adapter, everywhere except `bun test`, where nothing
 * installs a database client — `@postly/db`'s `selectDriver` makes the same carve-out. Built on
 * first use: the adapter takes the process client, which boot installs after this module loads.
 */
let store: ApiKeyStore | undefined;
const keys = (): ApiKeyStore => {
  store ??=
    resolveEnvironment({ env: Bun.env }) === 'test' ? new MemoryAdapter() : new BuiltinAdapter();
  return store;
};

/** The mount's `resolveToken`: every wrong key is one `null`, a fault propagates. */
export const resolveRunKey = apiKeyResolver(keys);

export interface IssuedRunKey {
  readonly id: string;
  readonly prefix: string;
  /** The plaintext. Stored nowhere: the record holds a hash of its secret half. */
  readonly key: string;
}

export async function issueRunKeyFor(issuer: {
  readonly orgId: string;
  readonly userId: string;
  readonly clock: Clock;
}): Promise<IssuedRunKey> {
  const issued = issueApiKey({
    env: resolveEnvironment({ env: Bun.env }) === 'production' ? 'prod' : 'dev',
    scopes: Object.keys(RUN_KEY_SCOPES),
    ...issuer,
  });
  await keys().putApiKey(issued.record);
  return { id: issued.record.id, prefix: issued.record.prefix, key: issued.plaintext };
}

/** The org an issued key belongs to, or `null`: what `revokeRunKey`'s policy decides about. */
export async function runKeyOwner(id: string): Promise<{ readonly orgId: string } | null> {
  const record = await keys().findApiKeyById(id);
  return record === null || record.orgId === null ? null : { orgId: record.orgId };
}

export function revokeRunKeyById(id: string, clock: Clock): Promise<boolean> {
  return revokeApiKey(keys(), id, clock);
}
