// A bearer mount whose token resolves to a person who acts in one tenant per call, named in the
// query string: the tenant's actor is the caller from the `auth` stage on, and a missing, foreign
// or unknown tenant answers before any route code runs.

import { describe, expect, test } from 'bun:test';
import { type Actor, agentActor, successorLink, successorPathOf, userActor } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { type BearerMountRateLimit, bearerMount } from './bearer-mount';
import { type BearerMountTenant, isTenantValue } from './bearer-mount-tenant';
import { defineHttpConfig } from './config';
import { useRequestContext } from './context';
import { bearerMountInvalid } from './errors';
import { httpPipeline } from './pipeline';
import { memoryRateLimitStore } from './rate-limit';
import { jsonResponse } from './response';
import { httpRouter, type Route } from './router';

const person: Actor = userActor({ id: 'person_1' });
const other: Actor = userActor({ id: 'person_2' });
const ROLES: Readonly<Record<string, string>> = { org_a: 'admin', org_b: 'member' };

let ran = 0;
const seenActor = (): Response => {
  ran += 1;
  const actor = useRequestContext()?.actor;
  return jsonResponse({
    id: actor?.id ?? null,
    orgId: actor?.orgId ?? null,
    kind: actor?.kind ?? null,
    roles: actor?.roles ?? null,
  });
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
  {
    method: 'POST',
    path: '/api/rename-case',
    meta: {
      name: 'renameCase',
      auth: 'required',
      enforcedBy: 'handler',
      input: t.object({ title: t.string }),
    },
    handler: seenActor,
  },
  {
    method: 'GET',
    path: '/_x/query/old-case-list',
    meta: { name: 'oldCaseList', auth: 'required', enforcedBy: 'handler' },
    handler: (_request, ctx) => {
      ctx.headers.set('link', successorLink('/_x/query/case-list'));
      return seenActor();
    },
  },
  {
    method: 'GET',
    path: '/_x/query/old-case-feed',
    meta: { name: 'oldCaseFeed', auth: 'required', enforcedBy: 'handler' },
    // A handler that strips the tenant off the URL it was handed, after authentication.
    handler: (_request, ctx) => {
      ctx.url.searchParams.delete('org');
      ctx.headers.set('link', successorLink('/_x/query/case-list'));
      return seenActor();
    },
  },
];

const tenant = (over: Partial<BearerMountTenant> = {}): BearerMountTenant => ({
  arg: 'org',
  resolve: ({ person: who, value }) => {
    const role = ROLES[value];
    return role === undefined ? null : agentActor({ id: who.id, orgId: value, roles: [role] });
  },
  list: ({ person: who }) =>
    who.id === 'person_1'
      ? [{ value: 'org_a', name: 'A' }, { value: 'org_b' }]
      : [{ value: 'org_c' }],
  ...over,
});

const pipelineFor = (
  mountTenant: BearerMountTenant | null = tenant(),
  config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  mountLimit?: BearerMountRateLimit,
) =>
  httpPipeline({
    table: httpRouter([
      ...api,
      ...bearerMount({
        prefix: '/v1',
        routes: api,
        scopes: {
          'cases:read': ['caseList', 'oldCaseList', 'oldCaseFeed'],
          'cases:write': ['createCase', 'renameCase'],
        },
        resolveToken: (token) =>
          token === 'tok-read'
            ? { actor: person, scopes: new Set(['cases:read']) }
            : token === 'tok-all'
              ? { actor: person, scopes: new Set(['cases:read', 'cases:write']) }
              : token === 'tok-other'
                ? { actor: other, scopes: new Set(['cases:read']) }
                : token === 'tok-none'
                  ? { actor: other, scopes: new Set<string>() }
                  : null,
        ...(mountTenant === null ? {} : { tenant: mountTenant }),
        rateLimitStore: memoryRateLimitStore(),
        ...(mountLimit === undefined ? {} : { rateLimit: mountLimit }),
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
    // The resolver's actor whole — its kind and its roles in THAT tenant — not the token's.
    expect(await answer(pipeline, call('POST', '/v1/create-case?org=org_a'))).toEqual({
      status: 200,
      body: { id: 'person_1', orgId: 'org_a', kind: 'agent', roles: ['admin'] },
    });
    expect(await answer(pipeline, call('GET', '/v1/case-list?org=org_b'))).toEqual({
      status: 200,
      body: { id: 'person_1', orgId: 'org_b', kind: 'agent', roles: ['member'] },
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
    expect((await answer(pipelineFor(), both)).body).toMatchObject({
      id: 'person_1',
      orgId: 'org_b',
    });
  });

  test('the tenant is read before the body stage: a malformed body naming none is X_BEARER_TENANT_REQUIRED', async () => {
    ran = 0;
    const malformed = (path: string) =>
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-all' },
        body: '{"title":',
      });
    const refused = await answer(pipelineFor(), malformed('/v1/rename-case'));
    expect(refused.status).toBe(400);
    expect(refused.body['code']).toBe('X_BEARER_TENANT_REQUIRED');
    // The same body with a tenant named reaches the body stage, which refuses it on its own terms.
    const parsed = await answer(pipelineFor(), malformed('/v1/rename-case?org=org_a'));
    expect(parsed.body['code']).not.toBe('X_BEARER_TENANT_REQUIRED');
    expect(parsed.status).toBe(422);
    expect(ran).toBe(0);
  });

  test('resolve is asked only after the cut and the length cap', async () => {
    const asked: string[] = [];
    const spied = tenant({
      resolve: ({ person: who, value }) => {
        asked.push(value);
        return agentActor({ id: who.id, orgId: value, roles: ['admin'] });
      },
    });
    const pipeline = pipelineFor(spied);
    // Out of scope, naming a tenant the spy would admit: the cut answers first.
    const hidden = await answer(pipeline, call('POST', '/v1/create-case?org=org_a', 'tok-read'));
    expect(hidden.status).toBe(404);
    // Past the cap: a non-member, unasked.
    const long = await answer(pipeline, call('POST', `/v1/create-case?org=${'x'.repeat(257)}`));
    expect(long).toEqual(hidden);
    expect(asked).toEqual([]);
    // At the cap, it is asked.
    const atCap = 'x'.repeat(256);
    expect((await answer(pipeline, call('GET', `/v1/case-list?org=${atCap}`))).status).toBe(200);
    expect(asked).toEqual([atCap]);
    // The cap is in characters: 256 astral code points are 512 UTF-16 units, and still asked.
    const astral = '\u{1F600}'.repeat(256);
    const named = `/v1/case-list?org=${encodeURIComponent(astral)}`;
    expect((await answer(pipeline, call('GET', named))).status).toBe(200);
    expect(asked).toEqual([atCap, astral]);
  });

  test('resolve is asked only after the per-token allowance: an exhausted token is 429, unasked', async () => {
    const asked: string[] = [];
    const spied = tenant({
      resolve: ({ person: who, value }) => {
        asked.push(value);
        return agentActor({ id: who.id, orgId: value, roles: ['admin'] });
      },
    });
    const pipeline = pipelineFor(spied, undefined, { limit: 1, windowMs: 60_000 });
    expect((await answer(pipeline, call('GET', '/v1/case-list?org=org_a'))).status).toBe(200);
    const exhausted = await answer(pipeline, call('GET', '/v1/case-list?org=org_a'));
    expect(exhausted.status).toBe(429);
    expect(exhausted.body['code']).toBe('X_RATE_LIMITED');
    expect(asked).toEqual(['org_a']);
  });

  test('a successor link keeps the tenant the call named, so following it as given works', async () => {
    // A value that needs escaping, so the link is proven to carry it re-encoded, not raw.
    const anyTenant = tenant({
      resolve: ({ person: who, value }) => agentActor({ id: who.id, orgId: value, roles: [] }),
    });
    const response = await pipelineFor(anyTenant).handle(
      call('GET', '/v1/old-case-list?org=org%20a%26b'),
      { role: 'web' },
    );
    expect(response.status).toBe(200);
    const link = response.headers.get('link') ?? '';
    expect(link).toBe('</v1/case-list?org=org%20a%26b>; rel="successor-version"');
    // Followed as given, with the same token, the successor acts in the tenant the call named.
    const followed = await answer(pipelineFor(anyTenant), call('GET', successorPathOf(link) ?? ''));
    expect(followed).toMatchObject({ status: 200, body: { orgId: 'org a&b' } });
    // The tenant authenticated, not whatever the handler left in the URL afterwards.
    const stripped = await pipelineFor().handle(call('GET', '/v1/old-case-feed?org=org_a'), {
      role: 'web',
    });
    expect(stripped.headers.get('link')).toBe('</v1/case-list?org=org_a>; rel="successor-version"');
    const plain = await pipelineFor(null).handle(call('GET', '/v1/old-case-list'), {
      role: 'web',
    });
    expect(plain.headers.get('link')).toBe(successorLink('/v1/case-list'));
  });

  test('no tenant named is X_BEARER_TENANT_REQUIRED, whose fix names the listing', async () => {
    ran = 0;
    for (const path of ['/v1/create-case', '/v1/create-case?org=']) {
      const refused = await answer(pipelineFor(), call('POST', path));
      expect(refused.status).toBe(400);
      expect(refused.body['code']).toBe('X_BEARER_TENANT_REQUIRED');
      expect(String(refused.body['fix'])).toContain('/v1/tenants');
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
        // Any fault the app's lookup raises; an UltimateError stands in for it.
        throw bearerMountInvalid('/v1', 'the directory is down');
      },
    });
    const thrown = await answer(pipelineFor(throwing), call('GET', '/v1/case-list?org=org_a'));
    expect(thrown.status).toBe(500);
    expect(thrown.body['code']).toBe('X_BEARER_TENANT_UNRESOLVED');
    const shapeless = tenant({ resolve: () => undefined as unknown as null });
    const odd = await answer(pipelineFor(shapeless), call('GET', '/v1/case-list?org=org_a'));
    expect(odd.body['code']).toBe('X_BEARER_TENANT_UNRESOLVED');
    // An object with a string `kind` is not yet an actor: an unknown kind, or no id, never runs.
    ran = 0;
    for (const malformed of [{ kind: 'robot', id: 'r' }, { kind: 'agent' }]) {
      const loose = tenant({ resolve: () => malformed as unknown as Actor });
      const refused = await answer(pipelineFor(loose), call('GET', '/v1/case-list?org=org_a'));
      expect(refused.status).toBe(500);
      expect(refused.body['code']).toBe('X_BEARER_TENANT_UNRESOLVED');
    }
    expect(ran).toBe(0);
  });

  test('GET <prefix>/tenants lists the person own tenants, with any valid token and no tenant', async () => {
    const listed = await answer(pipelineFor(), call('GET', '/v1/tenants', 'tok-read'));
    expect(listed).toEqual({
      status: 200,
      body: { tenants: [{ value: 'org_a', name: 'A' }, { value: 'org_b' }] },
    });
    // `list` is asked about the token's own person: another token's person gets their own list.
    expect(await answer(pipelineFor(), call('GET', '/v1/tenants', 'tok-other'))).toEqual({
      status: 200,
      body: { tenants: [{ value: 'org_c' }] },
    });
    // No scope at all still lists: discovery is not any primitive's scope.
    expect(await answer(pipelineFor(), call('GET', '/v1/tenants', 'tok-none'))).toEqual({
      status: 200,
      body: { tenants: [{ value: 'org_c' }] },
    });
    const anonymous = await pipelineFor().handle(new Request('http://localhost/v1/tenants'), {
      role: 'web',
    });
    expect(anonymous.status).toBe(401);
  });

  test('a listed value no call could send back is X_BEARER_TENANT_LIST_INVALID, never published', async () => {
    // Empty, past the cap, a lone surrogate (no call can encode it), and no string at all.
    const unsendable: readonly unknown[] = ['', 'x'.repeat(257), 'org_\uD800', []];
    for (const value of unsendable) {
      const lying = tenant({ list: () => [{ value: 'org_a' }, { value: value as string }] });
      const refused = await answer(pipelineFor(lying), call('GET', '/v1/tenants'));
      expect(refused.status).toBe(500);
      expect(refused.body['code']).toBe('X_BEARER_TENANT_LIST_INVALID');
      expect(JSON.stringify(refused.body)).not.toContain('org_a');
    }
    // The cap counts characters, so 256 astral ones are listed.
    const astral = '\u{1F600}'.repeat(256);
    const wide = await answer(
      pipelineFor(tenant({ list: () => [{ value: astral }] })),
      call('GET', '/v1/tenants'),
    );
    expect(wide).toEqual({ status: 200, body: { tenants: [{ value: astral }] } });
  });

  test('isTenantValue is the listing rule an app filters with', () => {
    expect(['org_a', 'x'.repeat(256), '\u{1F600}'].every(isTenantValue)).toBe(true);
    const refused: readonly unknown[] = ['', 'x'.repeat(257), '\uDC00', 'a\uD800b', [], 7, null];
    expect(refused.filter(isTenantValue)).toEqual([]);
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
      body: { id: 'person_1', orgId: null, kind: 'user', roles: person.roles },
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
