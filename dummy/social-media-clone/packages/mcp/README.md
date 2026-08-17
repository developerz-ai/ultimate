# @social-media-clone/mcp

The app's own MCP tools. Part of the social-media-clone monorepo — see the root README for how it fits.

`appMcp()` projects every action and query that declared `mcp: { expose: true }`, straight from the
registry the app's boot filled. Call it **after** the app is loaded — `runRole()` and `loadApp()`
both scan `apps/*` first. Adding a tool means adding `mcp: { expose: true }` beside the primitive's
policy, never a list here.

`As of 2026-08` this catalog has no HTTP mount of its own: `defineAppMcp` is called without
`resolveToken`, so `AppMcp.route` is `undefined` and nothing in the app imports this module. It is
the catalog, not the server.
