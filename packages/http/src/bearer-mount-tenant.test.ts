// A bearer mount whose token resolves to a person who acts in one tenant per call, named in the
// query string: the tenant's actor is the caller from the `auth` stage on, and a missing, foreign
// or unknown tenant answers before any route code runs.

import { describe, expect, test } from 'bun:test';
import { type Actor, agentActor, userActor } from '@ultimat3/core';
import { bearerMount } from './bearer-mount';
import type { BearerMountTenant } from './bearer-mount-tenant';
import { defineHttpConfig } from './config';
import { useRequestContext } from './context';
import { httpPipeline } from './pipeline';
import { memoryRateLimitStore } from './rate-limit';
import { jsonResponse } from './response';
import { httpRouter, type Route } from './router';

const person: Actor = userActor({ id: 'person_1' });
const ROLES: Readonly<Record<string, string>> = { org_a: 'admin', org_b: 'member' };

let ran = 0;
const seenActor = (): Response => {
  ran += 1;
  const actor = useRequestContext()?.actor;
  return jsonResponse({ id: actor?.id ?? null, orgId: actor?.orgId ?? null });
};

const api: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/create-case',
    meta: { name: 'createCase', auth: 'required', enforcedBy: 'handler' },
    handler: seenActor,
  },
  {
    method: 'GET',
    path: '/_x/query/case-list',
    meta: { name: 'caseList', auth: 'required', enforcedBy: 'handler' },
    handler: seenActor,
  },
];

const tenant = (over: Partial<BearerMountTenant> = {}): BearerMountTenant => ({
  arg: 'org',
  resolve: ({ person: who, value }) => {
    const role = ROLES[value];
    return role === undefined ? null : agentActor({ id: who.id, orgId: value, roles: [role] });
  },
  list: () => [{ value: 'org_a', name: 'A' }, { value: 'org_b' }],
  ...over,
});

const pipelineFor = (
  mountTenant: BearerMountTenant | null = tenant(),
  config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
) =>
  httpPipeline({
    table: httpRouter([
      ...api,
      ...bearerMount({
        prefix: '/v1',
        routes: api,
        scopes: { 'cases:read': ['caseList'], 'cases:write': ['createCase'] },
        resolveToken: (token) =>
          token === 'tok-read'
            ? { actor: person, scopes: new Set(['cases:read']) }
            : token === 'tok-all'
              ? { actor: person, scopes: new Set(['cases:read', 'cases:write']) }
              : null,
        ...(mountTenant === null ? {} : { tenant: mountTenant }),
        rateLimitStore: memoryRateLimitStore(),
      }),
    ]),
    config,
  });

const call = (method: string, path: string, token = 'tok-all'): Request =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

const answer = async (pipeline: ReturnType<typeof pipelineFor>, request: Request) => {
  const response = await pipeline.handle(request, { role: 'web' });
  const body = (await response.json()) as Record<string, unknown>;
  const { requestId: _id, ...stable } = body;
  return { status: response.status, body: stable };
};

describe('bearerMount({ tenant })', () => {
  test('the call acts as the tenant actor resolve answered, on a write and a read alike', async () => {
    const pipeline = pipelineFor();
    expect(await answer(pipeline, call('POST', '/v1/create-case?org=org_a'))).toEqual({
      status: 200,
      body: { id: 'person_1', orgId: 'org_a' },
    });
    expect(await answer(pipeline, call('GET', '/v1/case-list?org=org_b'))).toEqual({
      status: 200,
      body: { id: 'person_1', orgId: 'org_b' },
    });
  });

  test('the tenant is read from the query string in the auth stage, never from the body', async () => {
    const posted = new Request('http://localhost/v1/create-case', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-all' },
      body: JSON.stringify({ org: 'org_a' }),
    });
    expect((await answer(pipelineFor(), posted)).body['code']).toBe('X_BEARER_TENANT_REQUIRED');
    const both = new Request('http://localhost/v1/create-case?org=org_b', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-all' },
      body: JSON.stringify({ org: 'org_a' }),
    });
    expect((await answer(pipelineFor(), both)).body).toEqual({ id: 'person_1', orgId: 'org_b' });
  });

  test('no tenant named is X_BEARER_TENANT_REQUIRED, whose fix names the listing', async () => {
    ran = 0;
    for (const path of ['/v1/create-case', '/v1/create-case?org=']) {
      const refused = await answer(pipelineFor(), call('POST', path));
      expect(refused.status).toBe(400);
      expect(refused.body['code']).toBe('X_BEARER_TENANT_REQUIRED');
      expect(String(refused.body['fix'])).toContain('GET /v1/tenants');
    }
    expect(ran).toBe(0);
  });

  test('a tenant the person is not in and an unknown one answer exactly as a hidden primitive', async () => {
    ran = 0;
    const pipeline = pipelineFor();
    const foreign = await answer(pipeline, call('POST', '/v1/create-case?org=org_z'));
    const unknown = await answer(pipeline, call('POST', `/v1/create-case?org=${'x'.repeat(300)}`));
    const hidden = await answer(pipeline, call('POST', '/v1/create-case?org=org_a', 'tok-read'));
    expect(foreign.status).toBe(404);
    expect(foreign.body['code']).toBe('X_ROUTE_NOT_FOUND');
    expect(unknown).toEqual(foreign);
    expect(hidden).toEqual(foreign);
    expect(ran).toBe(0);
  });

  test('a resolve that throws or answers no actor is X_BEARER_TENANT_UNRESOLVED, never a 404', async () => {
    const throwing = tenant({
      resolve: () => {
        throw new TypeError('directory down');
      },
    });
    const thrown = await answer(pipelineFor(throwing), call('GET', '/v1/case-list?org=org_a'));
    expect(thrown.status).toBe(500);
    expect(thrown.body['code']).toBe('X_BEARER_TENANT_UNRESOLVED');
    const shapeless = tenant({ resolve: () => undefined as unknown as null });
    const odd = await answer(pipelineFor(shapeless), call('GET', '/v1/case-list?org=org_a'));
    expect(odd.body['code']).toBe('X_BEARER_TENANT_UNRESOLVED');
  });

  test('GET <prefix>/tenants lists the person own tenants, with any valid token and no tenant', async () => {
    const listed = await answer(pipelineFor(), call('GET', '/v1/tenants', 'tok-read'));
    expect(listed).toEqual({
      status: 200,
      body: { tenants: [{ value: 'org_a', name: 'A' }, { value: 'org_b' }] },
    });
    const anonymous = await pipelineFor().handle(new Request('http://localhost/v1/tenants'), {
      role: 'web',
    });
    expect(anonymous.status).toBe(401);
  });

  test('the tenant is the rate-limit subject: one tenant spent leaves another its allowance', async () => {
    const config = defineHttpConfig({
      dev: false,
      rateLimit: {
        scope: 'process',
        defaultBucket: 'default',
        tenantBucket: 'tenant',
        buckets: {
          default: { capacity: 100, refillPerSecond: 0.001 },
          tenant: { capacity: 1, refillPerSecond: 0.001 },
        },
      },
    });
    const pipeline = pipelineFor(tenant(), config);
    expect((await answer(pipeline, call('GET', '/v1/case-list?org=org_a'))).status).toBe(200);
    expect((await answer(pipeline, call('GET', '/v1/case-list?org=org_a'))).status).toBe(429);
    expect((await answer(pipeline, call('GET', '/v1/case-list?org=org_b'))).status).toBe(200);
  });

  test('a mount without tenant is unchanged: the token actor, and no listing route', async () => {
    const pipeline = pipelineFor(null);
    expect(await answer(pipeline, call('GET', '/v1/case-list'))).toEqual({
      status: 200,
      body: { id: 'person_1', orgId: null },
    });
    expect((await answer(pipeline, call('GET', '/v1/tenants'))).status).toBe(404);
  });

  test('a bad arg, or a primitive served at <prefix>/tenants, is refused at construction', () => {
    const mount =
      (over: Partial<BearerMountTenant>, routes: readonly Route[] = api) =>
      () =>
        bearerMount({
          prefix: '/v1',
          routes,
          scopes: { 'cases:read': routes.map((route) => route.meta.name) },
          resolveToken: () => null,
          tenant: tenant(over),
        });
    expect(mount({ arg: 'not a name' })).toThrow(
      expect.objectContaining({ code: 'X_BEARER_MOUNT_INVALID' }),
    );
    const taken: Route = {
      method: 'GET',
      path: '/_x/query/tenants',
      meta: { name: 'tenants', auth: 'required', enforcedBy: 'handler' },
      handler: seenActor,
    };
    expect(mount({}, [taken])).toThrow(expect.objectContaining({ code: 'X_BEARER_MOUNT_INVALID' }));
  });
});
