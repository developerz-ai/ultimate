// The `api` shape's key slice: an org's API key, issued by an admin, resolved by the `/v1` bearer
// mount. The framework's own `issueApiKey` / `apiKeyResolver` over `x_api_keys`; no second store.

import type { GeneratedFile } from '../naming';

const DIR = 'apps/web/app/keys';

const keys = (): string => `/**
 * An org's API key: a machine caller's credential for the actions and queries a browser would call.
 * No second API — the \`/v1\` mount (\`api/index.ts\`) re-serves them behind \`resolveApiKey\`.
 *
 * A key's scopes ARE its permissions (\`apiKeyActor\`), so a key issued with \`post:write\` passes
 * \`canPostWrite\` for the org it was issued in and for nothing else.
 */

import type { ApiKeyVerifyStore } from '@ultimat3/auth';
import {
  apiKeyResolver,
  issueApiKey,
  memoryAuthAdapter,
  postgresAuthAdapter,
} from '@ultimat3/auth';
import { type Clock, resolveEnvironment, storeMode } from '@ultimat3/core';

/** Every scope a key can carry; the map below says what each one reaches. */
export const apiKeyScopes = ['post:read', 'post:write'] as const;

export type ApiKeyScope = (typeof apiKeyScopes)[number];

/** What a key may do, and the one map the \`/v1\` mount cuts its routes by. */
export const API_KEY_SCOPES = {
  'post:read': ['postList'],
  'post:write': ['createPost', 'archivePost'],
} as const satisfies Record<ApiKeyScope, readonly string[]>;

/**
 * \`x_api_keys\` through the framework's adapter, except under \`bun test\`, where no database client
 * is installed — core's \`storeMode\`, the answer \`packages/db\`'s driver reads too. Built on first
 * use: the adapter takes the process client, which the boot installs after this module loads.
 */
let store: ApiKeyVerifyStore | undefined;
const keyStore = (): ApiKeyVerifyStore => {
  store ??= storeMode(Bun.env) === 'memory' ? memoryAuthAdapter() : postgresAuthAdapter();
  return store;
};

/** The mount's \`resolveToken\`: every wrong key is one \`null\` (401), a fault propagates. */
export const resolveApiKey = apiKeyResolver(keyStore);

export interface IssuedKey {
  readonly id: string;
  readonly prefix: string;
  /** The plaintext. Stored nowhere: the record holds a hash of its secret half. */
  readonly key: string;
}

/** A key for one org, with every scope unless \`scopes\` narrows it. Owned by the org, not a user. */
export async function issueKeyFor(issuer: {
  readonly orgId: string;
  readonly clock: Clock;
  readonly scopes?: readonly ApiKeyScope[] | undefined;
}): Promise<IssuedKey> {
  const issued = issueApiKey({
    env: resolveEnvironment({ env: Bun.env }) === 'production' ? 'prod' : 'dev',
    scopes: issuer.scopes ?? apiKeyScopes,
    orgId: issuer.orgId,
    clock: issuer.clock,
  });
  await keyStore().putApiKey(issued.record);
  return { id: issued.record.id, prefix: issued.record.prefix, key: issued.plaintext };
}
`;

const keysTest =
  (): string => `// A key, issued and presented back: who it resolves to, and that a wrong one is nobody.
import { systemClock } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { apiKeyScopes, issueKeyFor, resolveApiKey } from './keys';

const ORG = '00000000-0000-4000-8000-0000000000a1';

unitTest('an issued key resolves to its org, carrying every scope', async () => {
  const issued = await issueKeyFor({ orgId: ORG, clock: systemClock });
  const caller = await resolveApiKey(issued.key);
  expect(caller?.actor.orgId).toBe(ORG);
  expect([...(caller?.scopes ?? [])].sort()).toEqual([...apiKeyScopes].sort());
});

unitTest('a key narrowed to reads carries reads only', async () => {
  const issued = await issueKeyFor({ orgId: ORG, clock: systemClock, scopes: ['post:read'] });
  expect([...((await resolveApiKey(issued.key))?.scopes ?? [])]).toEqual(['post:read']);
});

unitTest('a key nobody issued is nobody, never an error', async () => {
  expect(await resolveApiKey('sk_dev_0000000000000000_not-a-real-secret')).toBeNull();
});
`;

const policy =
  (): string => `// Who may mint an org's API key: an admin of that org. A key is a credential that outlives the
// session that issued it, so it is its own grant rather than a side effect of \`post:write\`.

import { can, definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'key:issue': true;
  }
}

export const keyPermissions = definePermissions(['key:issue']);

/** Issue takes no org from its input — the key is the actor's own org's — so the actor must HAVE one. */
export const canKeyIssue = can(
  'key:issue',
  ({ actor }) => actor !== null && typeof actor.orgId === 'string' && actor.orgId !== '',
);
`;

const issueAction =
  (): string => `// Mint an API key for the caller's org. The answer is a credential shown once, so there is no
// \`mcp\` block: a tool result is kept in a transcript.

import { action, t } from '@ultimat3/action';
import { apiKeyScopes, issueKeyFor } from '../keys';
import { canKeyIssue } from '../policy';

export const issueKey = action({
  input: t.object({ scopes: t.array(t.enum(apiKeyScopes)).optional() }),
  output: t.object({ id: t.string, prefix: t.string, key: t.string }),
  policy: canKeyIssue,
  async handle({ input, ctx }) {
    return issueKeyFor({ orgId: ctx.actor?.orgId ?? '', clock: ctx.clock, scopes: input.scopes });
  },
});
`;

const issueActionTest = (): string => `// Who may mint a key, and what the key can then do.
import { testActor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { resolveApiKey } from '../keys';
import { issueKey } from './issue-key';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const target = issueKey.named('issueKey');

unitTest('a member without the grant is refused', async () => {
  const member = testActor('member', { orgId: ORG, permissions: ['post:read'] }).actor;
  await expect(target.as(member, {})).rejects.toBeUltimateError('X_FORBIDDEN');
});

unitTest("an admin's key resolves to the admin's org, with the scopes asked for", async () => {
  const admin = testActor('admin', { orgId: ORG, permissions: ['key:issue'] }).actor;
  const issued = await target.as(admin, { scopes: ['post:read'] });
  const caller = await resolveApiKey(issued.key);
  expect(caller?.actor.orgId).toBe(ORG);
  expect([...(caller?.scopes ?? [])]).toEqual(['post:read']);
});
`;

/** `apps/web/app/keys/`: the key store, its policy, the issuing action and their tests. */
export function apiKeyFiles(): readonly GeneratedFile[] {
  return [
    { path: `${DIR}/keys.ts`, contents: keys() },
    { path: `${DIR}/keys.test.ts`, contents: keysTest() },
    { path: `${DIR}/policy.ts`, contents: policy() },
    { path: `${DIR}/actions/issue-key.ts`, contents: issueAction() },
    { path: `${DIR}/actions/issue-key.test.ts`, contents: issueActionTest() },
  ];
}
