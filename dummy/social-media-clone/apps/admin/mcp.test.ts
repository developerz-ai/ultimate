// The admin's agent surface is MOUNTED: a route at /admin/mcp beside the web's /mcp, a 401 for no
// token or one this process does not honour, and per caller over HTTP — the seeded view-only
// `admin` role sees no write tool, an `operator` sees them and its call is answered.
import {
  agentTokenResolver,
  DEV_AGENT_TOKEN_PREFIX,
} from '@social-media-clone/web/app/auth/agent-token';
import { agentActor } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';

// `./mcp` reaches `pages/ops.tsx` through the admin: the render loader first, then the module
// (`static-tsx-imports.test.ts`).
await import('@ultimat3/render/server');
const { adminAgentOf, adminAgentsOver, mcp } = await import('./mcp');

/** How `x dev`'s own MCP client arrives: from this machine, sending no `Origin`. */
const LOOPBACK = { address: '127.0.0.1' };

const rpc = (token: string | null, method: string, params: Record<string, unknown> = {}) =>
  new Request('http://localhost/admin/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

interface RpcBody {
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[];
    readonly isError?: boolean;
    readonly content?: readonly { readonly text?: string }[];
  };
}

/** The same endpoint over the app's resolver, in the one environment the dev token is honoured. */
const underDev = () => {
  const { route } = adminAgentsOver(
    agentTokenResolver({
      env: { ULTIMATE_ENV: 'development' },
      auth: () => expect.unreachable('a dev token asks no key store'),
    }),
  );
  return route ?? expect.unreachable('apps/admin/mcp.ts built no route');
};

const toolsOf = async (role: string): Promise<readonly string[]> => {
  const response = await underDev().handle(
    rpc(`${DEV_AGENT_TOKEN_PREFIX}${role}`, 'tools/list'),
    LOOPBACK,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as RpcBody;
  return (body.result?.tools ?? []).map((tool) => tool.name);
};

const WRITES = /^admin\.[a-z_]+\.(create|update|delete)$/;

unitTest(
  'POST /admin/mcp is mounted, and answers 401 with no token or one not honoured',
  async () => {
    const route = mcp.route;
    if (route === undefined) return expect.unreachable('apps/admin/mcp.ts built no route');
    expect(route.path).toBe('/admin/mcp');
    expect((await route.handle(rpc(null, 'tools/list'), LOOPBACK)).status).toBe(401);
    // The development token is refused outside `x dev`: `bun test` is not development.
    const dev = await route.handle(
      rpc(`${DEV_AGENT_TOKEN_PREFIX}operator`, 'tools/list'),
      LOOPBACK,
    );
    expect(dev.status).toBe(401);
  },
);

unitTest('the view-only admin sees the dashboard’s reads and none of its writes', async () => {
  const tools = await toolsOf('admin');
  expect(tools).toContain('admin.users.list');
  expect(tools.filter((name) => WRITES.test(name))).toEqual([]);
});

unitTest('an operator sees the writes, and its call to a dashboard tool is answered', async () => {
  const tools = await toolsOf('operator');
  expect(tools).toContain('admin.users.update');
  const response = await underDev().handle(
    rpc(`${DEV_AGENT_TOKEN_PREFIX}operator`, 'tools/call', {
      name: 'admin.users.list',
      arguments: {},
    }),
    LOOPBACK,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as RpcBody;
  expect(body.result?.isError).not.toBe(true);
  expect(body.result?.content?.[0]?.text ?? '').toContain('rows');
});

unitTest(
  'a key issued with scopes is held to its admin ones; none is as strong as its actor',
  () => {
    expect(adminAgentOf(null)).toBeNull();
    const actor = agentActor({ id: 'k1', roles: ['operator'] });
    expect(adminAgentOf({ actor, scopes: new Set(['admin:read']) })?.tokenScopes).toEqual([
      'admin:read',
    ]);
    expect(adminAgentOf({ actor, scopes: new Set() })?.tokenScopes).toBeUndefined();
  },
);
