// Postly's own MCP endpoint: `POST /mcp`, mounted by `x dev` and by the web role, which find this
// file by its path and its `mcp` export. The catalog is `webMcp()`'s — every exposed action and
// query, the hand-written tools and the app's `jobTool`s; who may call it is an org API key
// (`app/runs/keys.ts`), the credential the `/v1` mount already takes, whose scopes are its
// permissions. Built when the boot scan reaches this file, after `apps/web/api` registered.
import { resolveOrgKey } from './app/runs/keys';
import { webMcp } from './mcp-tools';

export const mcp = webMcp({ resolveToken: resolveOrgKey });
