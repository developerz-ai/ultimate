// The admin surface's MCP endpoint: `POST /admin/mcp`, mounted beside `apps/web/mcp.ts` by `x dev`
// and the web role, which mount every `apps/<app>/mcp.ts` by its path and its `mcp` export. Built
// HERE, at module scope and nowhere under `apps/admin/app/`: the scan evaluates this file after
// every primitive registered, and a catalog projected earlier is `X_MCP_INCLUDE_EARLY` at mount.
import {
  type AgentCaller,
  type CallerFacts,
  resolveAgentToken,
} from '@social-media-clone/web/app/auth/agent-token';
import { type AdminMcpActor, adminMcp } from '@ultimat3/admin';
import { admin } from './app/admin/admin';

/**
 * The admin's actor for the agent the app's resolver answered — the same agent `/mcp` serves. A
 * key issued with scopes is held to its `admin:*` ones (a key scoped `posts:write` alone may call
 * nothing here); a caller with none — `dev-agent.<role>` — is as strong as its role.
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

type AgentResolver = (token: string, facts?: CallerFacts) => Promise<AgentCaller | null>;

/** The endpoint over a resolver: the app's below, a development one in its test. */
export const adminAgentsOver = (resolve: AgentResolver): ReturnType<typeof adminMcp> =>
  adminMcp({
    app: admin,
    path: '/admin/mcp',
    include: 'exposed',
    actor: async ({ token, facts }) =>
      adminAgentOf(token === undefined ? null : await resolve(token, facts)),
  });

export const mcp = adminAgentsOver(resolveAgentToken);
