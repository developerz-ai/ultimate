// The demo's `RuntimeOverrides`, read by `x dev` and `apps/web/server.ts` alike: the plain routes no
// primitive projects to. Today that is the MCP authorization server's RFC wire —
// `/.well-known/oauth-authorization-server`, `POST /oauth/{token,register,revoke,…}`.

import { mcpOAuth } from './app/oauth/server';

export const runtime = { routes: mcpOAuth.routes };
