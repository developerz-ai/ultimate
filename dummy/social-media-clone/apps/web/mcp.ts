// The app's own MCP endpoint: `POST /mcp`, mounted by `x dev` and by the web role, which find
// this file by its path and its `mcp` export. The tools are `@social-media-clone/mcp`'s catalog;
// who may call them is `resolveAgentToken`. Delete this file to unmount it — the gate's `manifest`
// step then says X_MCP_APP_UNMOUNTED — or set `ai: { mcp: { expose: false } }` in app.config.ts.
//
// Built when the boot scan reaches this file, after `apps/*/api` registered its actions: a tool
// declared later in a running `x dev` is on `POST /mcp` from its next restart.
import { appMcp } from '@social-media-clone/mcp';
import { resolveAgentToken } from './app/auth/agent-token';

export const mcp = appMcp({ resolveToken: resolveAgentToken });
