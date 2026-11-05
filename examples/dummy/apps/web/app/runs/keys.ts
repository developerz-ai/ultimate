/**
 * An org's API key: a machine caller's credential for the actions a browser already calls. No
 * second API — the `/v1` mount (`api/index.ts`) re-serves them, behind `resolveOrgKey`. Issued
 * and revoked by the runs console (`issueRunKey`), where it started.
 *
 * A key's scopes ARE its permissions (`apiKeyActor`), so a key issued with `run:write` passes
 * `canRunWrite` for the org it was issued in and for nothing else, and `post:publish` passes
 * `postPublish` for that org's posts and no other's.
 */

import type { ApiKeyVerifyStore } from '@ultimat3/auth';
import {
  apiKeyResolver,
  issueApiKey,
  memoryAuthAdapter,
  postgresAuthAdapter,
  revokeApiKey,
} from '@ultimat3/auth';
import { type Clock, resolveEnvironment, storeMode } from '@ultimat3/core';

/** What an org key may do, and the one map the mount cuts its routes by. */
export const ORG_KEY_SCOPES = {
  'run:write': ['startRun', 'answerPrompt', 'cancelRun'],
  'run:read': ['liveRunEvents'],
  'post:publish': ['publishPost'],
} as const;

/** A scope an org key can carry: a key of the map, so an unknown scope is a type error. */
export type OrgKeyScope = keyof typeof ORG_KEY_SCOPES;

/**
 * `x_api_keys` through the framework's adapter, everywhere except `bun test`, where nothing
 * installs a database client — core's `storeMode`, the answer `@postly/db`'s `selectDriver` reads
 * too. Built on first use: the adapter takes the process client, which boot installs after this
 * module loads.
 */
let store: ApiKeyVerifyStore | undefined;
const keys = (): ApiKeyVerifyStore => {
  store ??= storeMode(Bun.env) === 'memory' ? memoryAuthAdapter() : postgresAuthAdapter();
  return store;
};

/** The mount's `resolveToken`: every wrong key is one `null`, a fault propagates. */
export const resolveOrgKey = apiKeyResolver(keys);

export interface IssuedOrgKey {
  readonly id: string;
  readonly prefix: string;
  /** The plaintext. Stored nowhere: the record holds a hash of its secret half. */
  readonly key: string;
}

/**
 * The key is the ORG's, with no `userId`: whoever issues it is a Postly member, not an `x_users`
 * row, and `verifyApiKey` answers for a key's owner out of that table — an owner it cannot find
 * is a key it refuses. A key owned by nobody is cut by its scopes and its org alone.
 *
 * Every scope of the map unless `scopes` narrows it: a key that may start runs but not publish.
 */
export async function issueOrgKeyFor(issuer: {
  readonly orgId: string;
  readonly clock: Clock;
  readonly scopes?: readonly OrgKeyScope[];
}): Promise<IssuedOrgKey> {
  const { scopes = Object.keys(ORG_KEY_SCOPES), ...owner } = issuer;
  const issued = issueApiKey({
    env: resolveEnvironment({ env: Bun.env }) === 'production' ? 'prod' : 'dev',
    scopes,
    ...owner,
  });
  await keys().putApiKey(issued.record);
  return { id: issued.record.id, prefix: issued.record.prefix, key: issued.plaintext };
}

/** The org an issued key belongs to, or `null`: what `revokeRunKey`'s policy decides about. */
export async function orgKeyOwner(id: string): Promise<{ readonly orgId: string } | null> {
  const record = await keys().findApiKeyById(id);
  return record === null || record.orgId === null ? null : { orgId: record.orgId };
}

export function revokeOrgKeyById(id: string, clock: Clock): Promise<boolean> {
  return revokeApiKey(keys(), id, clock);
}
