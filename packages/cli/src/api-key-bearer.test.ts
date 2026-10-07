// The bearer mount behind real API keys, through the whole pipeline: `@ultimat3/auth`'s resolver
// as the mount's `resolveToken`, over a real key store. `@ultimat3/http` and `@ultimat3/auth` are
// one tier and import neither way, so this is the lowest package where the two meet.
//
// The failure this pins: a disabled user's key went on resolving on every mount, because key
// verification never looked at the owner.

import { describe, expect, test } from 'bun:test';
import {
  apiKeyResolver,
  defineAuth,
  disableUser,
  enableUser,
  issueApiKey,
  memoryAuthAdapter,
} from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import {
  bearerMount,
  defineHttpConfig,
  httpPipeline,
  httpRouter,
  jsonResponse,
  memoryRateLimitStore,
  useRequestContext,
} from '@ultimat3/http';

const clock = frozenClock('2026-10-02T09:00:00.000Z');
const ORG = '00000000-0000-4000-8000-0000000000a1';

const api: readonly Route[] = [
  {
    method: 'GET',
    path: '/_x/query/case-list',
    meta: { name: 'caseList', auth: 'required', enforcedBy: 'handler' },
    handler: () => jsonResponse({ actor: useRequestContext()?.actor.id ?? null }),
  },
];

const setup = async () => {
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({ adapter, clock });
  const owner = await adapter.createUser({
    id: 'ada',
    email: 'ada@corp.test',
    passwordHash: null,
    orgId: ORG,
    roles: [],
    createdAt: clock.now(),
  });
  await adapter.updateUser(owner.id, { permissions: ['cases:read'] });
  const issue = async (userId?: string) => {
    const issued = issueApiKey({ env: 'dev', scopes: ['cases:read'], userId, orgId: ORG, clock });
    await adapter.putApiKey(issued.record);
    return issued;
  };
  const owned = await issue(owner.id);
  const service = await issue();
  const pipeline = httpPipeline({
    table: httpRouter([
      ...api,
      ...bearerMount({
        prefix: '/v1',
        routes: api,
        scopes: { 'cases:read': ['caseList'] },
        resolveToken: apiKeyResolver(() => adapter, { clock }),
        rateLimitStore: memoryRateLimitStore(),
        clock,
      }),
    ]),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    hooks: { authenticate: () => null },
  });
  const get = (key: string): Promise<Response> =>
    pipeline.handle(
      new Request('http://localhost/v1/case-list', { headers: { authorization: `Bearer ${key}` } }),
      { role: 'web' },
    );
  return { adapter, auth, owned, service, get };
};

describe('unit · bearerMount behind apiKeyResolver', () => {
  test('a key whose owner is disabled is 401 on the next request, and works again once re-enabled', async () => {
    const { adapter, owned, get } = await setup();
    const live = await get(owned.plaintext);
    expect(live.status).toBe(200);
    // The actor is the KEY, never its owner.
    expect(await live.json()).toEqual({ actor: owned.record.id });

    // The column alone, as an operator's UPDATE would leave it: the key row itself is untouched.
    await adapter.updateUser('ada', { disabledAt: clock.now() });
    const refused = await get(owned.plaintext);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');

    await adapter.updateUser('ada', { disabledAt: null });
    expect((await get(owned.plaintext)).status).toBe(200);
  });

  test('disableUser revokes the key, so re-enabling the account does not bring it back', async () => {
    const { auth, owned, get } = await setup();
    await disableUser(auth, 'ada', 'offboarded');
    expect((await get(owned.plaintext)).status).toBe(401);
    await enableUser(auth, 'ada');
    expect((await get(owned.plaintext)).status).toBe(401);
  });

  test('an owner who lost the grant keeps a key that reaches nothing on the mount', async () => {
    const { adapter, owned, get } = await setup();
    await adapter.updateUser('ada', { permissions: [] });
    // Still a valid key — and the route it was scoped to is no longer on its side of the cut.
    expect((await get(owned.plaintext)).status).not.toBe(200);
  });

  test('a key no user owns is unaffected by any of it', async () => {
    const { auth, service, get } = await setup();
    await disableUser(auth, 'ada', 'offboarded');
    expect((await get(service.plaintext)).status).toBe(200);
  });
});
