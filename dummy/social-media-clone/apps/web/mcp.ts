// The app's own MCP endpoint: `POST /mcp`, mounted by `x dev` and by the web role, which find
// this file by its path and its `mcp` export. The tools are `@social-media-clone/mcp`'s catalog;
// who may call them is an API key (`resolveAgentToken`) or an OAuth token minted by
// `app/oauth/server.ts` for this endpoint. The 401 names that server (RFC 9728), so an MCP client
// discovers where to sign in. Delete this file to unmount it — the gate's `manifest` step then
// says X_MCP_APP_UNMOUNTED — or set `ai: { mcp: { expose: false } }` in app.config.ts.
//
// Built when the boot scan reaches this file, after `apps/*/api` registered its actions: a tool
// declared later in a running `x dev` is on `POST /mcp` from its next restart.
import { appMcp } from '@social-media-clone/mcp';
import type { McpRequestFacts } from '@ultimat3/mcp';
import { resolveAgentToken } from './app/auth/agent-token';
import { mcpOAuth } from './app/oauth/server';

/**
 * An OAuth token first — it is bound to this endpoint, so any other is `null` — then an API key.
 * Both answer `null` for a token that is not theirs, and the 401 is one answer for either.
 */
export const resolveMcpToken = async (token: string, facts: McpRequestFacts) =>
  (await mcpOAuth.resolveToken(token)) ?? (await resolveAgentToken(token, facts));

export const mcp = appMcp({ resolveToken: resolveMcpToken, oauth: mcpOAuth.oauth });
