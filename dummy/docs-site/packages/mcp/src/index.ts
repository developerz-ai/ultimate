// The app's own MCP tools. Every action with mcp.expose is already a tool; add app-specific
// read-only helpers here. Authorization is the action's policy, unchanged.
//
// A FUNCTION, and it imports no app (X_BOUNDARY_PACKAGE_TO_APP): `defineAppMcp` reads the registry
// where it is called, and `runRole()` and `loadApp()` both fill that registry before anything
// asks for the catalog. A module-scope call froze whatever had registered by import time.
import { defineAppMcp, type McpRequestFacts, type ResolvedToken } from '@ultimat3/mcp';

/** Who a bearer token is, or `null` for nobody — answered 401. */
export type TokenResolver = (
  token: string,
  facts: McpRequestFacts,
) => Promise<ResolvedToken | null> | ResolvedToken | null;

export interface AppMcpOptions {
  /** `apps/web/mcp.ts` passes the app's resolver; without one there is no route. */
  readonly resolveToken?: TokenResolver | undefined;
}

// `include: 'exposed'` projects straight from the registry. Re-listing the actions here would
// copy `mcp: { expose: true }` into a second place, and the copy goes stale in silence.
export const appMcp = (options: AppMcpOptions = {}) =>
  defineAppMcp({
    name: 'docs-site',
    include: 'exposed',
    ...(options.resolveToken === undefined ? {} : { resolveToken: options.resolveToken }),
  });
