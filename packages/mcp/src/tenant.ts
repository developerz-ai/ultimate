// `defineAppMcp({ tenant })` — one token across tenants, the tenant named per call.
//
// The token resolves to a PERSON (`resolveToken`, unchanged); every `tools/call` names the tenant it
// acts in under `tenant.arg`. The arg is stripped before anything reads the arguments, membership is
// the app's `resolve`, and the actor it answers IS the caller from there on — visibility, scope,
// args, admit, confirmation, policy, `ctx.actor.orgId` — so the tenancy guards see one org per call.
// A tenant the person is not in answers exactly as a hidden tool; a lookup that throws never does.
// The token's scopes and MCP role carry unchanged; the actor is `resolve`'s alone, so it may narrow.
// Only `tools/call` comes through here: every other method runs as the person, in no tenant.
// Which calls may name no tenant at all is `tenant-discover.ts`.

import type { Actor } from '@ultimat3/core';
import { isJsonObject, logger, renderCauseValue, renderThrowable } from '@ultimat3/core';
import {
  McpTenantInvalidError,
  McpTenantRequiredError,
  McpTenantUnresolvedError,
} from './catalog-errors';
import { McpToolDuplicateError } from './errors';
import type { AnyMcpTool, McpCaller, ToolListEntry } from './registry';
import { jsonResult, withoutKey } from './registry';
import type { TenantSurface } from './tenant-discover';
import { assertTenantDoors, LIST_TENANTS, tenantLister } from './tenant-discover';
import type { JsonSchema } from './wire';
import { NO_ARGS } from './wire';

/** One tenant the person may act in, as `list_tenants` shows it. */
export interface McpTenantEntry {
  /** What a call sends as `tenant.arg`. */
  readonly value: string;
  /** A label for the model choosing between them. */
  readonly name?: string;
}

export interface McpTenant {
  /** The argument every `tools/call` names its tenant under — `'project'`, `'org'`. */
  readonly arg: string;
  /**
   * The actor this person acts as in tenant `value`, or `null` when they are not a member — `null`
   * answers as a hidden tool. Must answer a `kind: 'agent'` actor; a throw is
   * `X_MCP_TENANT_UNRESOLVED`, never read as "not a member". The answer REPLACES the person's actor
   * — no role of theirs is merged in — so this is where a tenant's authority is narrowed.
   */
  resolve(input: {
    readonly person: Actor;
    readonly value: string;
  }): Promise<Actor | null> | Actor | null;
  /**
   * The tenants this person may name, served by `list_tenants` (or the `discover` tool) — what
   * `X_MCP_TENANT_REQUIRED` points at.
   */
  list(input: {
    readonly person: Actor;
  }): Promise<readonly McpTenantEntry[]> | readonly McpTenantEntry[];
  /**
   * The tool that lists the tenants IN PLACE of `list_tenants`, which is then not registered, so
   * the tool list keeps its size: `'list_resources'` (on a surface that is `'meta'` or
   * `'meta-split'` for every caller) or an ungrouped tool of `tools:` with no `visibleTo`. A call
   * of it naming no tenant answers `list` as the person, behind the tool's own scope and whatever
   * else it sends; a call naming one runs the tool itself, in that tenant. Refused at boot
   * otherwise (`X_MCP_TENANT_INVALID`).
   */
  readonly discover?: string;
  /**
   * Ungrouped tools of `tools:` a call may reach with no tenant: they then run as the PERSON —
   * no `orgId`, `caller.tenant` absent — and as the tenant actor when the call names one. A
   * server's own manual (`docs`), an identity tool. Refused at boot for a name that is not such a
   * tool (`X_MCP_TENANT_INVALID`).
   */
  readonly optional?: readonly string[];
}

export { LIST_TENANTS } from './tenant-discover';

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A value longer than this names no tenant anyone issues; refused without asking `resolve`. */
const MAX_TENANT_VALUE = 256;

/**
 * Boot: the arg is a plain name no tool's input declares, `list_tenants` is not taken while the
 * server registers it, and `discover` / `optional` name tools every caller reaches.
 */
export function assertTenant(
  tenant: McpTenant,
  tools: readonly AnyMcpTool[],
  meta: TenantSurface = {},
): void {
  const arg: unknown = tenant.arg;
  if (typeof arg !== 'string' || !ARG_NAME.test(arg)) {
    throw new McpTenantInvalidError({
      cause: `tenant.arg is ${renderCauseValue(arg)}, and it has to be a plain argument name`,
    });
  }
  for (const tool of tools) {
    if (tenant.discover === undefined && tool.name === LIST_TENANTS) {
      throw new McpToolDuplicateError({ name: LIST_TENANTS });
    }
    assertArgFree(arg, tool);
  }
  assertTenantDoors(tenant, tools, meta);
}

/** The arg is stripped from every call, so a tool declaring it would never receive it. */
export function assertArgFree(arg: string, tool: AnyMcpTool): void {
  if (Object.hasOwn(tool.inputSchema.properties ?? {}, arg)) {
    throw new McpTenantInvalidError({
      cause: `tool ${renderCauseValue(tool.name)} declares an input property "${arg}", which tenant.arg strips from every call`,
    });
  }
}

/**
 * The person's own tenants, nothing else — no scope, no tenant. Registered as `list_tenants`, or
 * run in place of the `discover` tool when a call of it names no tenant: that answer also says
 * how to name one, since the tool's own description is about something else.
 */
export function listTenantsTool(tenant: McpTenant): AnyMcpTool {
  const discover = tenant.discover;
  return {
    name: LIST_TENANTS,
    title: 'List tenants',
    description: `The tenants this caller may act in. Every other tool takes one of their values as "${tenant.arg}". Read-only.`,
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true, openWorldHint: false },
    destructive: false,
    async handle(_args, caller) {
      const listed = await tenant.list({ person: caller.actor });
      return jsonResult({
        tenants: listed.map((entry) => ({
          value: entry.value,
          ...(entry.name === undefined ? {} : { name: entry.name }),
        })),
        ...(discover === undefined
          ? {}
          : { next: `${discover}({ "${tenant.arg}": "<one of the values>" })` }),
      });
    },
  };
}

/**
 * `tools/list` with the tenant arg published — never in a tool's own schema — and required only
 * where a call without it is refused: not on `list_tenants` (which takes none), the `discover`
 * tool or an `optional` one.
 */
export function withTenantArg(
  entries: readonly ToolListEntry[],
  tenant: McpTenant,
): readonly ToolListEntry[] {
  const lister = tenantLister(tenant);
  const from = `The tenant this call acts in: a value from ${lister}.`;
  return entries.map((entry) => {
    if (entry.name === lister) {
      return tenant.discover === undefined
        ? entry
        : {
            ...entry,
            inputSchema: published(
              entry.inputSchema,
              tenant.arg,
              'The tenant this call acts in. Omit it to list the tenants this caller may act in.',
              false,
            ),
          };
    }
    return tenant.optional?.includes(entry.name) === true
      ? {
          ...entry,
          inputSchema: published(
            entry.inputSchema,
            tenant.arg,
            `${from} Optional here: without it the call acts in no tenant.`,
            false,
          ),
        }
      : { ...entry, inputSchema: published(entry.inputSchema, tenant.arg, from, true) };
  });
}

function published(
  schema: JsonSchema,
  arg: string,
  description: string,
  required: boolean,
): JsonSchema {
  const properties: Record<string, JsonSchema> = { ...schema.properties };
  Object.defineProperty(properties, arg, {
    value: { type: 'string', description },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return required
    ? { ...schema, properties, required: [...(schema.required ?? []), arg] }
    : { ...schema, properties };
}

/** One call's tenant step. `not-member` is answered exactly as a hidden tool. */
export type TenantStep =
  | { readonly kind: 'ok'; readonly caller: McpCaller; readonly args: unknown }
  | { readonly kind: 'refused'; readonly error: McpTenantRequiredError | McpTenantUnresolvedError }
  | { readonly kind: 'not-member' };

/**
 * Strip the arg, ask membership, build the call's caller. Runs before visibility, so every gate after
 * it — and the policy — sees the tenant's actor. A fresh caller per call: nothing is cached.
 */
export async function tenantStep(
  tenant: McpTenant,
  rawArgs: unknown,
  caller: McpCaller,
): Promise<TenantStep> {
  const args = isJsonObject(rawArgs) ? rawArgs : {};
  const value = Object.hasOwn(args, tenant.arg) ? args[tenant.arg] : undefined;
  if (typeof value !== 'string' || value.length === 0) {
    return {
      kind: 'refused',
      error: new McpTenantRequiredError({ arg: tenant.arg, lister: tenantLister(tenant) }),
    };
  }
  if (value.length > MAX_TENANT_VALUE) return { kind: 'not-member' };
  let actor: Actor | null;
  try {
    actor = await tenant.resolve({ person: caller.actor, value });
  } catch (thrown) {
    return unresolved(`tenant.resolve threw: ${renderThrowable(thrown)}`, thrown);
  }
  if (actor === null) return { kind: 'not-member' };
  // `undefined` (a `Map.get` miss) is neither the member `null` nor an actor: reading `.kind` off
  // it threw a TypeError out of the step.
  if (typeof actor !== 'object' || (actor as { kind?: unknown }).kind !== 'agent') {
    return unresolved(
      'tenant.resolve answered something that is not an actor of kind "agent", nor null',
    );
  }
  return {
    kind: 'ok',
    caller: { ...caller, actor, tenant: value },
    args: withoutKey(args, tenant.arg),
  };
}

function unresolved(cause: string, thrown?: unknown): TenantStep {
  const error = new McpTenantUnresolvedError({
    cause,
    ...(thrown === undefined ? {} : { sourceError: thrown }),
  });
  logger.error('mcp.tenant.unresolved', { surface: 'mcp', code: error.code, cause: error.cause });
  return { kind: 'refused', error };
}
