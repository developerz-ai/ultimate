// Single responsibility: the one way this package's authorization-server tests build a server, a
// PKCE pair, an authorize URL and a request to one of its routes. Test-only: excluded from the
// published files (`*-fixture.ts`) and absent from `index.ts`.

import { assert, type FrozenClock, frozenClock } from '@ultimat3/core';
import { type AuthorizationServer, authorizationServer } from './authorization-server';
import type { AuthorizationServerOptions } from './authorization-server-config';
import { type AuthServerStore, memoryAuthServerStore } from './authorization-server-store';
import type { AuthServerClient } from './authorization-server-types';
import { DEVICE_GRANT } from './authorization-server-types';
import { base64Url, randomToken } from './tokens';

export const ISSUER = 'https://as.test';
export const RESOURCE = 'https://as.test/mcp';
export const REDIRECT = 'https://app.test/callback';
export const T0 = Date.parse('2026-11-06T09:00:00.000Z');

export interface ServerFixture {
  readonly server: AuthorizationServer;
  readonly clock: FrozenClock;
  readonly store: AuthServerStore;
  /** A public client: PKCE is its proof. */
  readonly client: AuthServerClient;
}

export async function serverFixture(
  over: Partial<AuthorizationServerOptions> = {},
): Promise<ServerFixture> {
  const clock = frozenClock(T0);
  const store = over.store ?? memoryAuthServerStore();
  const server = authorizationServer({
    issuer: ISSUER,
    store,
    consentPath: '/oauth/consent',
    devicePath: '/oauth/device',
    lifetimes: { accessSeconds: 600, refreshIdleDays: 30, clientSeconds: 300 },
    scopes: ['read', 'write', 'admin'],
    resources: [RESOURCE],
    grants: ['authorization_code', 'refresh_token', 'client_credentials', DEVICE_GRANT],
    clock,
    ...over,
  });
  const { client } = await server.registerClient({
    name: 'Test app',
    redirectUris: [REDIRECT],
    grantTypes: ['authorization_code', 'refresh_token', DEVICE_GRANT],
    scopes: ['read', 'write'],
  });
  return { server, clock, store, client };
}

export function pkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomToken(32);
  const digest = new Bun.CryptoHasher('sha256').update(verifier).digest();
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function authorizeUrl(
  clientId: string,
  challenge: string,
  extra: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(`${ISSUER}/oauth/consent`);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'read write',
    state: 'st-1',
    resource: RESOURCE,
    ...extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** POST a form to one of the server's routes, the way http's pipeline would hand it over. */
export async function post(
  server: AuthorizationServer,
  path: string,
  form: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const route = server.routes.find((r) => r.method === 'POST' && r.path === path);
  assert(route !== undefined, `the server mounts no POST ${path}`, 'enable the grant that adds it');
  const raw = new Request(`${ISSUER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  const bytes = new Uint8Array(await raw.clone().arrayBuffer());
  const response = await route.handler(
    { raw, bodyBytes: async () => bytes },
    { ip: '203.0.113.9' },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Consent → code → tokens, the happy path every rule test starts from. */
export async function codeFor(
  fixture: ServerFixture,
  extra: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: string; readonly verifier: string; readonly redirect: URL }> {
  const { verifier, challenge } = pkce();
  const read = await fixture.server.readRequest(
    authorizeUrl(fixture.client.clientId, challenge, extra),
  );
  assert(read.ok, 'readRequest refused the fixture request', 'fix the authorizeUrl extras');
  const redirect = new URL(
    await fixture.server.approve({ subject: 'user-1', request: read.request }),
  );
  return { code: redirect.searchParams.get('code') ?? '', verifier, redirect };
}

export async function tokensFor(fixture: ServerFixture) {
  const { code, verifier } = await codeFor(fixture);
  return post(fixture.server, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: fixture.client.clientId,
  });
}
