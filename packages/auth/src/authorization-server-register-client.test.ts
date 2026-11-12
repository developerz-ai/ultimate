// `registerClient`, the app's own registration path (a partner's machine client, a first-party CLI):
// every list value must survive the store, whose Postgres columns are space-joined text — so a
// value with whitespace inside, or an empty one, is refused with a code before anything is stored.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { RegisterClientInput } from './authorization-server-clients';
import { REDIRECT, serverFixture } from './authorization-server-fixture';
import type { AuthServerClient } from './authorization-server-types';

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (!isUltimateError(error)) return 'not-an-UltimateError';
    return `${error.code} ${String(error.meta?.['field'])}`;
  }
  return 'did-not-throw';
};

const CASES: readonly (readonly [string, Partial<RegisterClientInput>, string])[] = [
  [
    'a space inside a redirect',
    { redirectUris: [`${REDIRECT} https://evil.test/cb`] },
    'redirectUris',
  ],
  ['a tab inside a scope', { scopes: ['read\twrite'] }, 'scopes'],
  ['a newline inside a resource', { resources: ['https://as.test/mcp\n'] }, 'resources'],
  ['a space inside a grant', { grantTypes: ['authorization_code '] as never }, 'grantTypes'],
  ['an empty scope', { scopes: [''] }, 'scopes'],
];

describe('registerClient screens what the store would split', () => {
  for (const [label, input, field] of CASES) {
    test(`${label} is X_AUTH_CLIENT_INVALID naming ${field}, and nothing is stored`, async () => {
      const { server, store } = await serverFixture();
      const stored: AuthServerClient[] = [];
      const putClient = store.putClient.bind(store);
      store.putClient = async (client) => {
        stored.push(client);
        await putClient(client);
      };
      const attempt = server.registerClient({
        name: 'Partner',
        redirectUris: [REDIRECT],
        ...input,
      });
      expect(await refusal(attempt)).toBe(`X_AUTH_CLIENT_INVALID ${field}`);
      expect(stored).toEqual([]);
    });
  }

  test('clean values register, and read back exactly as given', async () => {
    const { server, store } = await serverFixture();
    const { client } = await server.registerClient({
      name: 'Partner CLI',
      redirectUris: [REDIRECT, 'http://127.0.0.1:8123/cb'],
      scopes: ['read', 'write'],
      resources: ['https://as.test/mcp'],
    });
    expect(await store.getClient(client.clientId)).toEqual(client);
  });
});
