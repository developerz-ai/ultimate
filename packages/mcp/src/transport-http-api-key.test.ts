// The MCP endpoint behind real API keys: `@ultimat3/auth`'s resolver as `resolveToken`, a real
// key store. The failure this pins: a user minted a key and was then disabled, and the endpoint
// went on answering for them — the transport took whatever the resolver said, and the resolver
// never looked at the key's owner.

import { describe, expect, test } from 'bun:test';
import {
  apiKeyResolver,
  defineAuth,
  disableUser,
  enableUser,
  issueApiKey,
  MemoryAdapter,
} from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { textResult } from './registry';
import { createMcpServer } from './server';
import { mcpHttpRoute } from './transport-http';

const clock = frozenClock('2026-10-02T09:00:00.000Z');
const ORG = '00000000-0000-4000-8000-0000000000a1';

const server = createMcpServer({
  tools: [
    {
      name: 'echo',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handle() {
        return textResult('ok');
      },
    },
  ],
});

const setup = async () => {
  const adapter = new MemoryAdapter(clock);
  const auth = defineAuth({ adapter, clock });
  const owner = await adapter.createUser({
    id: 'ada',
    email: 'ada@corp.test',
    passwordHash: null,
    orgId: ORG,
    roles: [],
    createdAt: clock.now(),
  });
  await adapter.updateUser(owner.id, { permissions: ['tools:call'] });
  const owned = issueApiKey({
    env: 'dev',
    scopes: ['tools:call'],
    userId: owner.id,
    orgId: ORG,
    clock,
  });
  const service = issueApiKey({ env: 'dev', scopes: ['tools:call'], orgId: ORG, clock });
  await adapter.putApiKey(owned.record);
  await adapter.putApiKey(service.record);
  const route = mcpHttpRoute({ server, resolveToken: apiKeyResolver(() => adapter, { clock }) });
  const status = async (key: string): Promise<number> => {
    const response = await route.handle(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    return response.status;
  };
  return { adapter, auth, owned, service, status };
};

describe('mcpHttpRoute behind apiKeyResolver', () => {
  test('a key whose owner is disabled is 401 on the next request, and works again once re-enabled', async () => {
    const { adapter, owned, status } = await setup();
    expect(await status(owned.plaintext)).toBe(200);

    // The column alone, as an operator's UPDATE would leave it: the key row itself is untouched.
    await adapter.updateUser('ada', { disabledAt: clock.now() });
    expect(await status(owned.plaintext)).toBe(401);

    await adapter.updateUser('ada', { disabledAt: null });
    expect(await status(owned.plaintext)).toBe(200);
  });

  test('disableUser revokes the key, so re-enabling the account does not bring it back', async () => {
    const { auth, owned, status } = await setup();
    await disableUser(auth, 'ada', 'offboarded');
    expect(await status(owned.plaintext)).toBe(401);
    await enableUser(auth, 'ada');
    expect(await status(owned.plaintext)).toBe(401);
  });

  test('a key no user owns is unaffected by any of it', async () => {
    const { auth, service, status } = await setup();
    await disableUser(auth, 'ada', 'offboarded');
    expect(await status(service.plaintext)).toBe(200);
  });
});
