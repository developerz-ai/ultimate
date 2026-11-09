// The admin's agent surface is MOUNTED: a route at /admin/mcp beside the web's /mcp, refusing a
// request with no token or one this process does not honour, and answering per caller over HTTP —
// a staff agent the dashboard's tools for its role, an org key none (it holds no `admin:*` grant).
import { agentTokenResolver, DEV_AGENT_TOKEN_PREFIX } from '@postly/web/app/auth/agent-token';
import { issueOrgKeyFor, resolveOrgKey } from '@postly/web/app/runs/keys';
import { frozenClock } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { adminAgentOf, adminAgentsOver, mcp } from './mcp';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const clock = frozenClock('2026-10-01T09:00:00.000Z');
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

/** The same endpoint over the same resolver, in the one environment the dev token is honoured. */
const underDev = () => {
  const { route } = adminAgentsOver(agentTokenResolver({ env: { ULTIMATE_ENV: 'development' } }));
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

unitTest('POST /admin/mcp is mounted, and answers 401 with no token or a forged one', async () => {
  const route = mcp.route;
  if (route === undefined) return expect.unreachable('apps/admin/mcp.ts built no route');
  expect(route.path).toBe('/admin/mcp');
  expect((await route.handle(rpc(null, 'tools/list'), LOOPBACK)).status).toBe(401);
  const forged = await route.handle(rpc('ult_dev_nobody', 'tools/list'), LOOPBACK);
  expect(forged.status).toBe(401);
  // The development token is refused outside `x dev`: `bun test` is not development.
  const dev = await route.handle(rpc(`${DEV_AGENT_TOKEN_PREFIX}owner`, 'tools/list'), LOOPBACK);
  expect(dev.status).toBe(401);
});

unitTest('the catalog is the dashboard: each resource its tools, each action one more', () => {
  const tools = mcp.tools.map((tool) => tool.name);
  for (const entity of ['orgs', 'members', 'posts', 'comments', 'connections']) {
    for (const op of ['list', 'read', 'create', 'update', 'delete']) {
      expect(tools).toContain(`admin.${entity}.${op}`);
    }
  }
  for (const entity of ['runs', 'run_events', 'post_like_totals', 'daily_likes']) {
    expect(tools).toContain(`admin.${entity}.list`);
    expect(tools).not.toContain(`admin.${entity}.create`);
  }
  for (const action of ['publishPost', 'inviteMember', 'upgradePlan', 'run.cancel']) {
    expect(tools).toContain(`admin.action.${action}`);
  }
  expect(tools).toContain('admin.search');
});

unitTest('a staff owner token sees the dashboard over HTTP, and calls a tool of it', async () => {
  const owner = await toolsOf('owner');
  expect(owner).toContain('admin.orgs.list');
  expect(owner).toContain('admin.posts.delete');
  const response = await underDev().handle(
    rpc(`${DEV_AGENT_TOKEN_PREFIX}owner`, 'tools/call', { name: 'admin.orgs.list', arguments: {} }),
    LOOPBACK,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as RpcBody;
  expect(body.result?.isError).not.toBe(true);
  expect(body.result?.content?.[0]?.text ?? '').toContain('rows');
});

unitTest('a reader token sees none of the dashboard’s writes', async () => {
  const reader = await toolsOf('reader');
  expect(reader.filter((name) => /^admin\.[a-z_]+\.(create|update|delete)$/.test(name))).toEqual(
    [],
  );
});

unitTest('an org key resolves to its org and is held to its admin scopes: none', async () => {
  const issued = await issueOrgKeyFor({ orgId: ORG, clock });
  const agent = adminAgentOf(await resolveOrgKey(issued.key));
  if (agent === null) return expect.unreachable('an issued org key resolves');
  expect(agent.orgId).toBe(ORG);
  expect(agent.tokenScopes).toContain('run:write');
  const response = await mcp.route?.handle(rpc(issued.key, 'tools/list'), LOOPBACK);
  const body = (await response?.json()) as RpcBody;
  const tools = (body.result?.tools ?? []).map((tool) => tool.name);
  expect(tools.filter((name) => name.startsWith('admin.'))).toEqual([]);
  expect(adminAgentOf(null)).toBeNull();
});
