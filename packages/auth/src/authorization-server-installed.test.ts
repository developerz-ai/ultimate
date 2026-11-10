// The `authServerStore` port: `authorizationServer({ store })` may omit the store, and then serves
// the one the boot installed from `runtime.ts` — else the env default, Postgres over the app's pool.

import { afterEach, describe, expect, test } from 'bun:test';
import * as adapter from './adapter-subpath';
import { authorizationServer } from './authorization-server';
import { resolveAuthServerConfig } from './authorization-server-config';
import {
  installAuthServerStore,
  installedAuthServerStore,
  resetAuthServerStore,
} from './authorization-server-installed';
import { memoryAuthServerStore } from './authorization-server-store';
import * as barrel from './index';

afterEach(() => resetAuthServerStore());

const config = (store?: ReturnType<typeof memoryAuthServerStore>) =>
  resolveAuthServerConfig({
    issuer: 'https://as.test',
    ...(store === undefined ? {} : { store }),
    consentPath: '/oauth/consent',
    lifetimes: { accessSeconds: 600, refreshIdleDays: 30 },
    scopes: ['read'],
  });

describe('unit · the installed authorization-server store', () => {
  test('a server declaring no store serves the installed one', () => {
    const store = memoryAuthServerStore();
    installAuthServerStore(store);
    expect(config().store).toBe(store);
  });

  // `runtime.ts` imports the module that builds the server BEFORE the boot installs
  // `runtime.authServerStore`, so the store is read per call — never captured at build.
  test('a server built before the install writes to the store installed after it', async () => {
    const server = authorizationServer({
      issuer: 'https://as.test',
      consentPath: '/oauth/consent',
      lifetimes: { accessSeconds: 600, refreshIdleDays: 30 },
      scopes: ['read'],
    });
    const store = memoryAuthServerStore();
    installAuthServerStore(store);
    const { client } = await server.registerClient({
      name: 'Late app',
      redirectUris: ['https://app.test/callback'],
      grantTypes: ['authorization_code'],
      scopes: ['read'],
    });
    expect(await store.getClient(client.clientId)).not.toBeNull();
  });

  test("the app's own store wins over the installed one", () => {
    installAuthServerStore(memoryAuthServerStore());
    const mine = memoryAuthServerStore();
    expect(config(mine).store).toBe(mine);
  });

  test('a release removes its own install only, in any order', () => {
    const first = memoryAuthServerStore();
    const second = memoryAuthServerStore();
    const releaseFirst = installAuthServerStore(first);
    const releaseSecond = installAuthServerStore(second);
    releaseFirst();
    expect(installedAuthServerStore()).toBe(second);
    releaseSecond();
    expect(installedAuthServerStore()).not.toBe(second);
  });

  test('nothing installed is the env default: a store, never undefined', () => {
    const fallback = installedAuthServerStore();
    expect(typeof fallback.getClient).toBe('function');
  });

  test('the installer is on ./adapter only', () => {
    expect(adapter.installAuthServerStore).toBe(installAuthServerStore);
    expect(Object.keys(barrel)).not.toContain('installAuthServerStore');
  });
});
