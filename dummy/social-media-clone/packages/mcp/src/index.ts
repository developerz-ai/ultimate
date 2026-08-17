// The app's own MCP catalog: every action and query that declared `mcp: { expose: true }`,
// projected from the registry the app's own boot fills.
//
// A FUNCTION, not a constant, and it imports no app. `defineAppMcp` reads `exposedPrimitives()`
// where it is called, so a module-scope call freezes whatever happened to be registered at import
// time — empty on some boots, full on others, which is the worst kind of correct. This file used
// to import `apps/web/api/health` to force one action in, which made a package reach up into the
// application that consumes it purely to keep a module-scope snapshot non-empty.

import type { AppMcp } from '@ultimat3/mcp';
import { defineAppMcp } from '@ultimat3/mcp';

/**
 * Call it after the app is loaded — `runRole()` and `loadApp()` both scan `apps/*` before anything
 * asks for a catalog. `include: 'exposed'` projects straight from the registry; re-listing the
 * actions here would copy `mcp: { expose: true }` into a second place, and the copy goes stale in
 * silence.
 */
export const appMcp = (): AppMcp =>
  defineAppMcp({
    name: 'social-media-clone',
    include: 'exposed',
  });
