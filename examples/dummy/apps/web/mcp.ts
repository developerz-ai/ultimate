// Postly's own MCP endpoint: `POST /mcp`, mounted by `x dev` and by the web role, which find this
// file by its path and its `mcp` export. The catalog is `webMcp()`'s — every exposed action and
// query, the hand-written tools and the app's `jobTool`s; who may call it is `resolveAgentToken`:
// an org API key (the `/v1` credential, scopes = permissions), or `dev-agent.<role>` under `x dev`.
// Built when the boot scan reaches this file, after `apps/web/api` registered.
import { resolveAgentToken } from './app/auth/agent-token';
import { webMcp } from './mcp-tools';

export const mcp = webMcp({ resolveToken: resolveAgentToken });
