// The one answer to "did this primitive opt into being an MCP tool?" — a literal `expose: true`.
// Core owns it because its readers span tiers 3-5 — `action`, `query`, `mcp`, `ai`, `manifest` —
// and this is the only tier all of them reach, the same reason `timing-safe-equal.ts` lives here.

/**
 * The `mcp` block, read structurally. Each package keeps its own richer declaration —
 * `ActionMcp` carries `visibleTo`, `@ultimat3/mcp`'s `McpExposure` carries `name` — and hands it
 * here; restating the one field they share binds this to none of them.
 */
export interface McpExposureDeclaration {
  readonly expose?: boolean | undefined;
}

/**
 * Opt-in, never opt-out: silence exposes nothing. An absent block, an omitted `expose` and a
 * literal `false` are one answer, because a tool the author never asked for is a capability
 * handed to every agent that can reach the surface — and writing an action is not a request to
 * hand one out.
 *
 * Six readers decided it three ways until 2026-08: `=== true` where a tool is actually built,
 * `!== false` in the OpenAPI hint and `?? true` in the manifest fact. So an action with no `mcp`
 * block was published as a tool by the contract and refused by every surface that could have
 * called one.
 *
 * The one deliberate exception is `@ultimat3/admin`'s OWN catalog, whose every tool is already
 * gated on an admin permission and whose CRUD tools carry no `mcp` block at all; there
 * `expose: false` withdraws a tool. That surface says so in `mcp-tools.ts` and in
 * `wiki/Admin-Dashboard.md`. Nothing else may grow a second default.
 */
export function isMcpExposed(declared: McpExposureDeclaration | undefined): boolean {
  return declared?.expose === true;
}
