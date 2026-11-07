// The per-caller catalog: what `tools/list` and `tools/call` read for ONE request, resolved per
// request (never cached) and merged with the boot catalog into a fresh `ToolRegistry` and meta
// surface, so every gate runs unchanged. A failure fails the request (`X_MCP_CATALOG_*`).
//
// Never a smaller catalog, never one name twice.

import type { ErrorAudience } from '@ultimat3/core';
import { fixFor, logger, stringField } from '@ultimat3/core';
import type { McpCatalogNameSource } from './catalog-errors';
import { McpCatalogToolDuplicateError, McpCatalogUnresolvedError } from './catalog-errors';
import { asFrameworkError, forAudience } from './framework-error';
import type { McpResourceGroups, McpSurfaceOption } from './meta-surface';
import { META_TOOL_NAMES, MetaSurface } from './meta-surface';
import type { AnyMcpTool, McpCaller } from './registry';
import { ToolRegistry } from './registry';
import type { McpTenant } from './tenant';
import { assertArgFree, LIST_TENANTS } from './tenant';
import type { JsonRpcId, JsonRpcResponse } from './wire';
import { errorResponse, INTERNAL_ERROR } from './wire';

/** What a catalog source answers for one caller: tools, and — on a meta server — their resources. */
export interface McpResolvedCatalog {
  readonly tools: readonly AnyMcpTool[];
  /** Resources for `list_resources`, beside the boot `groups:` — never one of the same name. */
  readonly groups?: McpResourceGroups | undefined;
}

/** `defineAppMcp({ catalog })`, already checked there (`runtimeTool()` only, scopes, confirmations). */
export type McpCatalogSource = (caller: McpCaller) => Promise<McpResolvedCatalog>;

/** The registry and meta surface one request reads. */
export interface CatalogView {
  readonly tools: ToolRegistry;
  readonly meta: MetaSurface | undefined;
}

export type CatalogAnswer =
  | { readonly ok: true; readonly view: CatalogView }
  | {
      readonly ok: false;
      readonly error: McpCatalogToolDuplicateError | McpCatalogUnresolvedError;
    };

/** What `McpServer` reads per request beyond its boot catalog. */
export interface PerCall {
  readonly catalog?: McpCatalogSource | undefined;
  readonly tenant?: McpTenant | undefined;
  /** The boot tools (with `list_tenants`) and meta declaration a resolved catalog merges with. */
  readonly tools: readonly AnyMcpTool[];
  readonly surface?: McpSurfaceOption | undefined;
  readonly groups?: McpResourceGroups | undefined;
}

export interface CatalogRefused {
  readonly error: McpCatalogToolDuplicateError | McpCatalogUnresolvedError;
}

/** The boot view when there is no catalog source, else this caller's merged one, or its refusal. */
export async function viewOf(
  perCall: PerCall | undefined,
  boot: CatalogView,
  caller: McpCaller,
): Promise<CatalogView | CatalogRefused> {
  if (perCall?.catalog === undefined) return boot;
  const answer = await catalogFor(
    {
      tools: perCall.tools,
      surface: perCall.surface,
      groups: perCall.groups,
      source: perCall.catalog,
      tenantArg: perCall.tenant?.arg,
    },
    caller,
  );
  return answer.ok ? answer.view : { error: answer.error };
}

/**
 * `tools/list` when the catalog cannot be served: one `-32603` with `{ code, cause, fix }` attached
 * — a 5xx, so a `'caller'` audience reads the hidden cause. `tools/call` renders it as a result.
 */
export function catalogRefusal(
  id: JsonRpcId,
  error: McpCatalogToolDuplicateError | McpCatalogUnresolvedError,
  audience: ErrorAudience,
): JsonRpcResponse {
  // Always framework-shaped — these are our own classes; the fallback only satisfies the type.
  const shown = forAudience(
    asFrameworkError(error) ?? {
      code: error.code,
      title: error.title,
      cause: error.cause,
      fix: error.fix,
    },
    audience,
  );
  const fix = fixFor(shown, audience);
  return errorResponse(id, INTERNAL_ERROR, `tool catalog unavailable — ${fix}`, {
    code: shown.code,
    cause: shown.cause,
    fix,
    ...(shown.docs === undefined ? {} : { docs: shown.docs }),
  });
}

export interface CatalogBoot {
  readonly tools: readonly AnyMcpTool[];
  readonly surface: McpSurfaceOption | undefined;
  readonly groups: McpResourceGroups | undefined;
  readonly source: McpCatalogSource;
  /** `tenant.arg`, which no runtime tool may declare either. */
  readonly tenantArg: string | undefined;
}

/** Resolve `boot.source` for this caller and merge it, or the refusal — logged once, here. */
export async function catalogFor(boot: CatalogBoot, caller: McpCaller): Promise<CatalogAnswer> {
  try {
    return { ok: true, view: merge(boot, await boot.source(caller)) };
  } catch (thrown) {
    const error =
      thrown instanceof McpCatalogToolDuplicateError || thrown instanceof McpCatalogUnresolvedError
        ? thrown
        : McpCatalogUnresolvedError.threw(thrown);
    logger.error('mcp.catalog.unresolved', {
      surface: 'mcp',
      code: error.code,
      cause: error.cause,
      actor: caller.actor.id,
      ...(caller.tenant === undefined ? {} : { tenant: caller.tenant }),
    });
    return { ok: false, error };
  }
}

function merge(boot: CatalogBoot, resolved: McpResolvedCatalog): CatalogView {
  if (!isRecord(resolved) || !Array.isArray(resolved.tools)) {
    throw new McpCatalogUnresolvedError({
      cause: 'the catalog resolver answered something other than { tools: [...] }',
    });
  }
  // Every name already answered: static tools (and `list_tenants`), and the meta tools, reserved
  // whatever the surface — a surface function may serve them to the next caller.
  const taken = new Map<string, McpCatalogNameSource>();
  for (const tool of boot.tools) {
    taken.set(tool.name, tool.name === LIST_TENANTS ? 'list_tenants' : 'tools:');
  }
  for (const name of META_TOOL_NAMES) taken.set(name, 'a meta tool');
  for (const tool of resolved.tools) {
    const first = taken.get(tool.name);
    if (first !== undefined) {
      throw new McpCatalogToolDuplicateError({ name: tool.name, kind: 'tool', first });
    }
    taken.set(tool.name, 'catalog');
    if (boot.tenantArg !== undefined) refused(() => assertArgFree(boot.tenantArg ?? '', tool));
  }
  const all = [...boot.tools, ...resolved.tools];
  return { tools: new ToolRegistry().registerAll(all), meta: metaOf(boot, resolved, all) };
}

/** The boot groups plus the resolved ones, held to every boot check `MetaSurface.build` makes. */
function metaOf(
  boot: CatalogBoot,
  resolved: McpResolvedCatalog,
  tools: readonly AnyMcpTool[],
): MetaSurface | undefined {
  const extra = resolved.groups === undefined ? [] : Object.entries(resolved.groups);
  const groups = new Map(Object.entries(boot.groups ?? {}));
  for (const [name, group] of extra) {
    if (groups.has(name)) {
      throw new McpCatalogToolDuplicateError({ name, kind: 'resource', first: 'groups:' });
    }
    groups.set(name, group);
  }
  return refused(() =>
    MetaSurface.build({
      surface: boot.surface,
      groups: groups.size === 0 ? undefined : Object.fromEntries(groups),
      tools,
    }),
  );
}

/**
 * A boot refusal (`X_MCP_GROUP_UNKNOWN`, `X_MCP_EFFECT_UNDECLARED`, `X_MCP_TENANT_INVALID`…) met at
 * request time is this catalog's refusal, naming the boot code it failed.
 */
function refused<T>(check: () => T): T {
  try {
    return check();
  } catch (thrown) {
    const code = stringField(thrown, 'code') ?? 'a check';
    throw new McpCatalogUnresolvedError({
      cause: `the resolved catalog fails ${code}: ${stringField(thrown, 'cause') ?? ''}`,
      sourceError: thrown,
    });
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
