// Single responsibility: the one purge-of-clients case both authorization-server stores run, so the
// memory and Postgres answers cannot drift. Test-only: excluded from the published files
// (`*-fixture.ts`) and absent from `index.ts`.

import { expect } from 'bun:test';
import type { AuthServerStore } from './authorization-server-store';
import type { AuthServerClient } from './authorization-server-types';

const T0 = Date.parse('2026-11-06T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const client = (clientId: string, createdAt: Date): AuthServerClient => ({
  clientId,
  name: clientId,
  secretHash: null,
  authMethod: 'none',
  redirectUris: ['https://app.test/cb'],
  grantTypes: ['authorization_code', 'refresh_token'],
  scopes: [],
  resources: [],
  createdAt,
});

/**
 * `purge(at(1000), at(500))`: only `d_old` goes — self-registered (`d_`), before the idle window,
 * holding no grant, code or device code. A static client, a granted one, a young one and one
 * mid-authorization all stay.
 */
export async function dynamicClientPurgeCase(store: AuthServerStore): Promise<void> {
  for (const [id, created] of [
    ['c_static-old', at(0)],
    ['d_old', at(0)],
    ['d_granted', at(0)],
    ['d_young', at(600)],
    ['d_code', at(0)],
    ['d_device', at(0)],
  ] as const) {
    await store.putClient(client(id, created));
  }
  await store.putGrant({
    id: 'g-live',
    clientId: 'd_granted',
    subject: 'u1',
    scopes: ['read'],
    resource: null,
    createdAt: at(0),
    refreshedAt: at(900),
    revokedAt: null,
  });
  await store.putCode({
    codeHash: 'code-live',
    grantId: 'g-pending',
    clientId: 'd_code',
    subject: 'u1',
    scopes: ['read'],
    resource: null,
    redirectUri: 'https://app.test/cb',
    codeChallenge: 'x'.repeat(43),
    expiresAt: at(2000),
    usedAt: null,
  });
  await store.putDevice({
    deviceCodeHash: 'dev-live',
    userCodeHash: 'uc-live',
    clientId: 'd_device',
    scopes: ['read'],
    resource: null,
    status: 'pending',
    subject: null,
    grantedScopes: null,
    intervalSeconds: 5,
    lastPolledAt: null,
    createdAt: at(900),
    expiresAt: at(2000),
  });
  expect(await store.purge(at(1000), at(500))).toBe(1);
  expect(await store.getClient('d_old')).toBeNull();
  for (const id of ['c_static-old', 'd_granted', 'd_young', 'd_code', 'd_device']) {
    expect((await store.getClient(id))?.clientId).toBe(id);
  }
}
