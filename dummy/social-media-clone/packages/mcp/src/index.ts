// The app's own MCP catalog: every action and query that declared `mcp: { expose: true }`,
// projected from the registry the app's own boot fills, and mounted at `POST /mcp` by
// `apps/web/mcp.ts` with the app's token resolver.
//
// A FUNCTION, not a constant, and it imports no app. `defineAppMcp` reads `exposedPrimitives()`
// where it is called, so a module-scope call freezes whatever happened to be registered at import
// time — empty on some boots, full on others, which is the worst kind of correct. This file used
// to import `apps/web/api/health` to force one action in, which made a package reach up into the
// application that consumes it purely to keep a module-scope snapshot non-empty.

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

/**
 * Call it after the app is loaded — `runRole()` and `loadApp()` both scan `apps/*` before anything
 * asks for a catalog. `include: 'exposed'` projects straight from the registry; re-listing the
 * actions here would copy `mcp: { expose: true }` into a second place, and the copy goes stale in
 * silence.
 */
export const appMcp = (options: AppMcpOptions = {}) =>
  defineAppMcp({
    name: 'social-media-clone',
    include: 'exposed',
    ...(options.resolveToken === undefined ? {} : { resolveToken: options.resolveToken }),
  });
