// The admin MCP surface's scopes: which admin permission each tool needs as a token scope, and
// what a resolved token carries. The gate itself is `@ultimat3/mcp`'s registry — this file only
// declares the cut (`defineAppMcp({ scopes })`) and the token's half of it.

import type { McpScopes } from '@ultimat3/mcp';
import { expandPermissions } from './authz';
import type { AdminMcpTool } from './mcp-tools';
import { ADMIN_DESTROY, ADMIN_PERMISSIONS } from './permissions';

const isAdminPermission = (scope: string): boolean =>
  (ADMIN_PERMISSIONS as readonly string[]).includes(scope);

/**
 * The scopes a token resolved to, as the registry checks them: by string membership, so the
 * admin's implications are expanded here (`admin:destroy` ⇒ `admin:write` ⇒ `admin:read`) and a
 * token granted `admin:write` is not refused a read.
 *
 * `undefined` — the app's resolver stated no scopes — is a token as strong as its actor: every
 * admin scope, with the actor's own policy still deciding each tool. That is what every admin MCP
 * token was before tools carried a scope, so an app that never issued a narrower token is
 * unchanged. An EMPTY list is a token granted nothing, never "unstated". A scope that is no admin
 * permission (`posts:write`) is dropped: the admin's tools are gated on its own vocabulary only.
 */
export function adminTokenScopes(granted: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(expandPermissions(granted ?? [ADMIN_DESTROY]).filter(isAdminPermission));
}

/**
 * Scope → the tools it covers, for `defineAppMcp({ scopes })`. Every tool is in exactly one entry
 * (its `scope`), so the map is total by construction and `X_MCP_SCOPE_UNCOVERED` cannot fire.
 */
export function adminToolScopes(tools: readonly AdminMcpTool[]): McpScopes {
  const by = new Map<string, string[]>();
  for (const tool of tools) by.set(tool.scope, [...(by.get(tool.scope) ?? []), tool.name]);
  return Object.fromEntries(by);
}
