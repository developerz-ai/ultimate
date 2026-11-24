// `tenant.discover` and `tenant.optional`: the calls a `tenant` server answers with no tenant named.
//
// By default one tool does, `list_tenants`. `discover` names a tool the server already serves to
// take its place — called without `tenant.arg` it answers `tenant.list`, called with it it is the
// tool it always was — so the tool list keeps its size. `optional` names tools that run as the
// PERSON without the arg and as the tenant actor with it. Both are boot-checked: a name no caller
// could reach would leave `X_MCP_TENANT_REQUIRED` pointing at nothing.

import { isJsonObject, renderCauseValue } from '@ultimat3/core';
import { McpTenantInvalidError } from './catalog-errors';
import type { McpResourceGroups, McpSurfaceOption } from './meta-surface';
import { LIST_RESOURCES, META_TOOL_NAMES } from './meta-surface';
import type { AnyMcpTool, McpCaller, ToolResolution } from './registry';

/** The tool a `tenant` server registers to list tenants when `discover` names no other. */
export const LIST_TENANTS = 'list_tenants';

/** The half of `McpTenant` this file reads. */
export interface TenantDoors {
  readonly arg: string;
  readonly discover?: string | undefined;
  readonly optional?: readonly string[] | undefined;
}

/** The meta declaration the discover and optional names are checked against. */
export interface TenantSurface {
  readonly surface?: McpSurfaceOption | undefined;
  readonly groups?: McpResourceGroups | undefined;
  /** The dispatcher envelopes' own fields: the arg is stripped from those too. */
  readonly split?: { readonly fields?: Readonly<Record<string, unknown>> | undefined } | undefined;
}

/**
 * How one call meets the tenant step. `'tenants'`: answer the tenant list. `'person'`: run the
 * tool as the person, in no tenant. `'step'`: the call names its tenant, or is refused.
 */
export type TenantDoor = 'tenants' | 'person' | 'step';

/** The tool that lists this server's tenants: what `X_MCP_TENANT_REQUIRED` points at. */
export const tenantLister = (tenant: TenantDoors): string => tenant.discover ?? LIST_TENANTS;

/**
 * Only an ABSENT arg opens a door. One that is present and unusable (`''`, `null`, a number) goes
 * to the step and is refused there: a malformed tenant never quietly becomes "no tenant".
 */
export function tenantDoor(tenant: TenantDoors, name: string, rawArgs: unknown): TenantDoor {
  // `list_tenants` takes no tenant whatever it is sent, as it always did.
  if (tenant.discover === undefined && name === LIST_TENANTS) return 'person';
  const named =
    isJsonObject(rawArgs) &&
    Object.hasOwn(rawArgs, tenant.arg) &&
    rawArgs[tenant.arg] !== undefined;
  if (named) return 'step';
  if (name === tenant.discover) return 'tenants';
  return tenant.optional?.includes(name) === true ? 'person' : 'step';
}

const FIX =
  "defineAppMcp({ tenant: { arg, resolve, list, discover: 'list_resources', optional: ['docs'] } }) — discover names list_resources (surface: 'meta' or 'meta-split', never a function) or an ungrouped tool of tools: with no visibleTo; optional names ungrouped tools of tools: — or drop the option the cause names";

function refuse(cause: string): never {
  throw new McpTenantInvalidError({ cause, fix: FIX });
}

/** Boot: `discover` and `optional` each name a tool every caller reaches by that name. */
export function assertTenantDoors(
  tenant: TenantDoors,
  tools: readonly AnyMcpTool[],
  meta: TenantSurface,
): void {
  if (Object.hasOwn(meta.split?.fields ?? {}, tenant.arg)) {
    throw new McpTenantInvalidError({
      cause: `split.fields declares "${tenant.arg}", which tenant.arg strips from every call`,
    });
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const grouped = new Set(Object.values(meta.groups ?? {}).flatMap((group) => group.tools));
  const discover: unknown = tenant.discover;
  if (discover !== undefined) assertDiscover(discover, byName, grouped, meta.surface);
  const optional: unknown = tenant.optional;
  if (optional === undefined) return;
  if (!Array.isArray(optional)) {
    refuse(
      `tenant.optional is ${renderCauseValue(optional)}, and it has to be a list of tool names`,
    );
  }
  const seen = new Set<unknown>();
  for (const name of optional as readonly unknown[]) {
    const shown = renderCauseValue(name);
    if (seen.has(name)) refuse(`tenant.optional names ${shown} twice`);
    seen.add(name);
    if (name === discover) {
      refuse(
        `tenant.optional names ${shown}, which is tenant.discover: with no tenant it answers the tenant list`,
      );
    }
    assertUngrouped('tenant.optional', name, byName, grouped);
  }
}

function assertDiscover(
  discover: unknown,
  tools: ReadonlyMap<string, AnyMcpTool>,
  grouped: ReadonlySet<string>,
  surface: McpSurfaceOption | undefined,
): void {
  const shown = renderCauseValue(discover);
  if (typeof discover === 'string' && META_TOOL_NAMES.includes(discover)) {
    if (discover !== LIST_RESOURCES) {
      refuse(
        `tenant.discover names ${shown}, and the one meta tool that can list tenants is "${LIST_RESOURCES}"`,
      );
    }
    // A function serves some callers 'flat', and they would have no tool to list their tenants.
    if (surface !== 'meta' && surface !== 'meta-split') {
      refuse(
        `tenant.discover names ${shown}, and surface is not 'meta' or 'meta-split' for every caller, so some caller is never served that tool`,
      );
    }
    return;
  }
  const tool = assertUngrouped('tenant.discover', discover, tools, grouped);
  // The tenant list is answered in the tool's place: its scope is still asked, but a caller it is
  // hidden from would be pointed at a tool it cannot see.
  if (tool.visibleTo !== undefined) {
    refuse(
      `tenant.discover names ${shown}, which declares visibleTo: a caller it is hidden from could not list its tenants`,
    );
  }
}

/**
 * A call of the discover tool that names no tenant, resolved: `lister` runs in its place, behind
 * the scope the tool itself declares — the one gate of its own a boot check has not ruled out.
 */
export function tenantsCall(
  lister: AnyMcpTool,
  discover: AnyMcpTool | undefined,
  name: string,
  caller: McpCaller,
): ToolResolution {
  const scope = discover?.scope;
  return scope !== undefined && !caller.scopes.has(scope)
    ? { kind: 'scope-denied', name, scope }
    : { kind: 'ok', tool: lister, args: {} };
}

function assertUngrouped(
  option: string,
  name: unknown,
  tools: ReadonlyMap<string, AnyMcpTool>,
  grouped: ReadonlySet<string>,
): AnyMcpTool {
  const shown = renderCauseValue(name);
  const tool = typeof name === 'string' ? tools.get(name) : undefined;
  if (tool === undefined) {
    return refuse(
      `${option} names ${shown}, which is not a tool of this server's tools: (a per-caller catalog tool and a meta dispatcher cannot be named)`,
    );
  }
  if (grouped.has(tool.name)) {
    return refuse(
      `${option} names ${shown}, which a group lists: a grouped tool is reached through a dispatcher, never by its name`,
    );
  }
  return tool;
}
