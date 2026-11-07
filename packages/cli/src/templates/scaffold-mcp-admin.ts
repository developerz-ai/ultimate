// The admin surface's own MCP endpoint, as `x new` writes it: `apps/admin/mcp.ts` — the file the
// mount reads for that app directory (`app-mcp.ts`) — serving the admin catalog and the app's
// exposed tools at `/admin/mcp`, behind the web surface's agent-token resolver. Mounted beside
// `apps/web/mcp.ts`, and REFUSING without a token, like it.

import type { GeneratedFile, NameSet } from './naming';

const endpoint = (
  app: NameSet,
): string => `// The admin surface's MCP endpoint: \`POST /admin/mcp\`, mounted beside \`apps/web/mcp.ts\` by \`x dev\`
// and the web role, which mount every \`apps/<app>/mcp.ts\` by its path and its \`mcp\` export. Staff
// agents get the admin's own tools (\`admin.<entity>.list\`, …) AND the app's exposed actions and
// queries (\`include: 'exposed'\`), each gated by the actor's permissions and the token's scope.
//
// Built HERE, at module scope, and nowhere under \`apps/admin/app/\`: the boot scan evaluates this
// file after every \`apps/*/{site,app,api,shared}\` module has registered its primitives, and the mount
// refuses a catalog projected before that (X_MCP_INCLUDE_EARLY) rather than serve it short.
import { type AgentCaller, resolveAgentToken } from '@${app.kebab}/web/app/auth/agent-token';
import { type AdminMcpActor, adminMcp } from '@ultimat3/admin';
import { admin } from './app/admin/admin';

/**
 * The admin's actor for the agent the app's resolver answered — the same agent \`/mcp\` serves,
 * tenant and grants included. A key issued with scopes is held to its \`admin:*\` ones (a key
 * scoped \`posts:write\` alone may call nothing here); a key with none is as strong as its actor.
 */
export const adminAgentOf = (caller: AgentCaller | null): AdminMcpActor | null => {
  if (caller === null) return null;
  const { id, roles, permissions, orgId } = caller.actor;
  return {
    id,
    roles,
    permissions,
    ...(orgId === undefined ? {} : { orgId }),
    ...(caller.scopes.size === 0 ? {} : { tokenScopes: [...caller.scopes] }),
  };
};

export const mcp = adminMcp({
  app: admin,
  path: '/admin/mcp',
  include: 'exposed',
  // The app's one resolver: an issued API key in every environment, \`dev-agent.<role>\` under
  // \`x dev\` from this machine alone — decided on how the request arrived (\`facts\`).
  actor: async ({ token, facts }) =>
    adminAgentOf(token === undefined ? null : await resolveAgentToken(token, facts)),
});
`;

const endpointTest = (
  app: NameSet,
): string => `// The admin endpoint is mounted and refusing: a route at /admin/mcp, and a 401 for a request that
// carries no token or one this process does not honour — before any tool, or the body, is read.
import { DEV_AGENT_TOKEN_PREFIX } from '@${app.kebab}/web/app/auth/agent-token';
import { DEMO_ORG_ID } from '@${app.kebab}/web/shared/demo-org';
import { agentActor } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { adminAgentOf, mcp } from './mcp';

const post = (headers: Record<string, string>) =>
  new Request('http://localhost/admin/mcp', { method: 'POST', headers, body: '{}' });

unitTest('POST /admin/mcp is mounted, and answers 401 without a token', async () => {
  const route = mcp.route;
  if (route === undefined) return expect.unreachable('apps/admin/mcp.ts built no route');
  expect(route.path).toBe('/admin/mcp');
  const response = await route.handle(post({}));
  expect(response.status).toBe(401);
  // The development token is refused outside \`x dev\`: \`bun test\` is not development.
  const dev = await route.handle(post({ authorization: \`Bearer \${DEV_AGENT_TOKEN_PREFIX}admin\` }));
  expect(dev.status).toBe(401);
});

unitTest('the agent /mcp resolves is the admin actor, tenant kept and scopes held', () => {
  const actor = agentActor({ id: 'k1', orgId: DEMO_ORG_ID, roles: ['admin'] });
  expect(adminAgentOf(null)).toBeNull();
  // No scopes on the key: as strong as its actor, whose own grants still decide each tool.
  expect(adminAgentOf({ actor, scopes: new Set() })).toEqual({
    id: 'k1',
    roles: ['admin'],
    permissions: [],
    orgId: DEMO_ORG_ID,
  });
  expect(adminAgentOf({ actor, scopes: new Set(['admin:read']) })?.tokenScopes).toEqual([
    'admin:read',
  ]);
});
`;

/** `apps/admin/mcp.ts` and the test that pins it mounted and refusing. */
export const mcpAdminFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: 'apps/admin/mcp.ts', contents: endpoint(app) },
  { path: 'apps/admin/mcp.test.ts', contents: endpointTest(app) },
];
