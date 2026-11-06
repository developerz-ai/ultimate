// The structural seam across tier 2, held by the compiler and the real pipeline: auth's `routes`
// ARE `@ultimat3/http` `Route`s and `oauthBearerResolver` IS a `BearerResolver` — assigned below,
// no cast — and a partner's client-credentials token, minted through `POST /oauth/token` on the
// whole pipeline, reaches a `bearerMount` route and dies there the moment it is revoked.
// Here and not in auth: auth may not import http (same tier); mcp sits above both.

import { describe, expect, test } from 'bun:test';
import { authorizationServer, memoryAuthServerStore, oauthBearerResolver } from '@ultimat3/auth';
import { agentActor, frozenClock } from '@ultimat3/core';
import {
  type BearerResolver,
  bearerMount,
  defineHttpConfig,
  httpPipeline,
  httpRouter,
  jsonResponse,
  memoryRateLimitStore,
  type Route,
  useRequestContext,
} from '@ultimat3/http';

const ISSUER = 'http://localhost';

const build = async () => {
  const clock = frozenClock('2026-11-06T09:00:00.000Z');
  const server = authorizationServer({
    issuer: ISSUER,
    store: memoryAuthServerStore(),
    consentPath: '/oauth/consent',
    lifetimes: { accessSeconds: 600, refreshIdleDays: 30, clientSeconds: 300 },
    scopes: ['cases:read'],
    grants: ['authorization_code', 'refresh_token', 'client_credentials'],
    clock,
  });
  const oauthRoutes: readonly Route[] = server.routes;
  const resolveToken: BearerResolver = oauthBearerResolver(server, {
    actor: (grant) => agentActor({ id: grant.subject }),
  });
  const api: readonly Route[] = [
    {
      method: 'GET',
      path: '/_x/query/case-list',
      meta: { name: 'caseList', auth: 'required', enforcedBy: 'handler' },
      handler: () => jsonResponse({ actor: useRequestContext()?.actor.id ?? null }),
    },
  ];
  const mounted = bearerMount({
    prefix: '/v1',
    routes: api,
    scopes: { 'cases:read': ['caseList'] },
    resolveToken,
    rateLimitStore: memoryRateLimitStore(),
    clock,
  });
  const pipeline = httpPipeline({
    table: httpRouter([...api, ...oauthRoutes, ...mounted]),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    hooks: {},
  });
  const { client, clientSecret } = await server.registerClient({
    name: 'Partner sync',
    authMethod: 'client_secret_basic',
    grantTypes: ['client_credentials'],
    scopes: ['cases:read'],
  });
  return { server, pipeline, client, clientSecret: clientSecret ?? '' };
};

describe('authorizationServer behind @ultimat3/http', () => {
  test('a client-credentials token reaches the bearer mount, and revoke ends it at once', async () => {
    const { server, pipeline, client, clientSecret } = await build();
    const minted = await pipeline.handle(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${btoa(`${client.clientId}:${clientSecret}`)}`,
        },
        body: 'grant_type=client_credentials',
      }),
      { role: 'web' },
    );
    expect(minted.status).toBe(200);
    expect(minted.headers.get('cache-control')).toBe('no-store');
    const token = String(((await minted.json()) as Record<string, unknown>)['access_token']);
    const read = () =>
      pipeline.handle(
        new Request(`${ISSUER}/v1/case-list`, { headers: { authorization: `Bearer ${token}` } }),
        { role: 'web' },
      );
    const answer = await read();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ actor: client.clientId });
    await server.revoke({ subject: client.clientId });
    expect((await read()).status).toBe(401);
  });

  test('the metadata document is served through the pipeline, public', async () => {
    const { pipeline } = await build();
    const answer = await pipeline.handle(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
      { role: 'web' },
    );
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/oauth/token`,
    });
  });
});
