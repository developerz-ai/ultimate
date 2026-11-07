// The refusals of a per-caller catalog (`defineAppMcp({ catalog })`) and of a per-call tenant
// (`defineAppMcp({ tenant })`). Codes and titles are registered in `errors.ts` with the rest of the
// package's; these classes sit apart so that file stays under the size ceiling.
//
// A runtime name came out of a row, so it is rendered (`renderCauseValue`/`renderFixLiteral`), never spliced.

import { renderCauseValue, renderFixLiteral, renderThrowable, UltimateError } from '@ultimat3/core';

/** Where a name the resolved catalog collided with came from. */
export type McpCatalogNameSource =
  | 'tools:'
  | 'catalog'
  | 'a meta tool'
  | 'list_tenants'
  | 'groups:';

/**
 * A resolved catalog answers to one name twice: a static tool, a meta tool, `list_tenants`, a boot
 * resource group, or another runtime entry. Boot's `X_MCP_TOOL_DUPLICATE` cannot fire for a name
 * that does not exist at boot, so this is that refusal at request time — the agent would otherwise
 * reach whichever copy the registry met first.
 */
export class McpCatalogToolDuplicateError extends UltimateError {
  constructor(input: {
    readonly name: unknown;
    readonly kind: 'tool' | 'resource';
    readonly first: McpCatalogNameSource;
  }) {
    super({
      code: 'X_MCP_CATALOG_TOOL_DUPLICATE',
      cause: `the catalog resolved a ${input.kind} named ${renderCauseValue(input.name)}, and ${input.first} already answers to that name`,
      fix: `defineAppMcp({ catalog: (caller) => ({ tools: [runtimeTool({ name: '<unique-name>', … })] }) }) — rename the runtime ${input.kind} now called ${renderFixLiteral(input.name, '<its name>')}; x mcp tools --json lists the static names`,
    });
  }
}

/**
 * The catalog could not be served for this caller: the resolver threw, or answered something this
 * server refuses to serve (an entry not built by `runtimeTool()`, a scope the boot map does not
 * declare, a schema outside the wire subset). Never a silently smaller catalog — a tool missing
 * from `tools/list` sends an agent away from a call that exists.
 */
export class McpCatalogUnresolvedError extends UltimateError {
  constructor(input: { readonly cause: string; readonly sourceError?: unknown }) {
    super({
      code: 'X_MCP_CATALOG_UNRESOLVED',
      cause: input.cause,
      fix: 'defineAppMcp({ catalog: (caller) => ({ tools: [runtimeTool({ name, description, inputSchema, permission, run })] }) }) — fix what the cause names in the catalog function: its throw, an entry not built by runtimeTool(), or a scope the boot scopes: map does not declare',
      ...(input.sourceError === undefined ? {} : { sourceError: input.sourceError }),
    });
  }

  /** The resolver itself threw: the thrown value rendered totally, never interpolated. */
  static threw(thrown: unknown): McpCatalogUnresolvedError {
    return new McpCatalogUnresolvedError({
      cause: `the catalog resolver threw: ${renderThrowable(thrown)}`,
      sourceError: thrown,
    });
  }
}

/** A call on a `tenant` server whose arguments carry no tenant value. */
export class McpTenantRequiredError extends UltimateError {
  constructor(input: { readonly arg: string }) {
    super({
      code: 'X_MCP_TENANT_REQUIRED',
      cause: `this server acts every call in the tenant the call names, and this call's arguments carry no "${input.arg}"`,
      fix: `list_tenants({}) — then send one of its values as "${input.arg}" in the arguments of every tools/call`,
    });
  }
}

/**
 * `tenant.resolve` threw, or answered an actor that is not an agent. A failed lookup is NOT "not a
 * member": answering it as not-found would tell an agent a tool it may call does not exist.
 */
export class McpTenantUnresolvedError extends UltimateError {
  constructor(input: { readonly cause: string; readonly sourceError?: unknown }) {
    super({
      code: 'X_MCP_TENANT_UNRESOLVED',
      cause: input.cause,
      fix: "defineAppMcp({ tenant: { arg, resolve: ({ person, value }) => (member ? agentActor({ id: person.id, orgId: value }) : null), list } }) — the cause names what refused; resolve answers a kind: 'agent' actor, or null for a non-member, and never throws",
      ...(input.sourceError === undefined ? {} : { sourceError: input.sourceError }),
    });
  }
}

/** `tenant.arg` is unusable: not a plain name, or a tool's own input already declares it. */
export class McpTenantInvalidError extends UltimateError {
  constructor(input: { readonly cause: string }) {
    super({
      code: 'X_MCP_TENANT_INVALID',
      cause: input.cause,
      fix: "defineAppMcp({ tenant: { arg: 'tenant', resolve, list } }) — pick an argument name no tool's input declares",
    });
  }
}
