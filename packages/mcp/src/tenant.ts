// `defineAppMcp({ tenant })` — one token across tenants, the tenant named per call.
//
// The token resolves to a PERSON (`resolveToken`, unchanged); every `tools/call` names the tenant it
// acts in under `tenant.arg`. The arg is stripped before anything reads the arguments, membership is
// the app's `resolve`, and the actor it answers IS the caller from there on — visibility, scope,
// args, admit, confirmation, policy, `ctx.actor.orgId` — so the tenancy guards see one org per call.
// A tenant the person is not in answers exactly as a hidden tool; a lookup that throws never does.
// The token's scopes and MCP role carry unchanged; the actor is `resolve`'s alone, so it may narrow.
// Only `tools/call` comes through here: every other method runs as the person, in no tenant.

import type { Actor } from '@ultimat3/core';
import { logger, renderCauseValue, renderThrowable } from '@ultimat3/core';
import {
  McpTenantInvalidError,
  McpTenantRequiredError,
  McpTenantUnresolvedError,
} from './catalog-errors';
import { McpToolDuplicateError } from './errors';
import type { AnyMcpTool, McpCaller, ToolListEntry } from './registry';
import { jsonResult, withoutKey } from './registry';
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
  /** The tenants this person may name, served by `list_tenants` — what `X_MCP_TENANT_REQUIRED` points at. */
  list(input: {
    readonly person: Actor;
  }): Promise<readonly McpTenantEntry[]> | readonly McpTenantEntry[];
}

/** The one tool a `tenant` server answers without a tenant: how a caller learns its tenants. */
export const LIST_TENANTS = 'list_tenants';

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A value longer than this names no tenant anyone issues; refused without asking `resolve`. */
const MAX_TENANT_VALUE = 256;

/** Boot: the arg is a plain name no tool's input declares, and `list_tenants` is not taken. */
export function assertTenant(tenant: McpTenant, tools: readonly AnyMcpTool[]): void {
  const arg: unknown = tenant.arg;
  if (typeof arg !== 'string' || !ARG_NAME.test(arg)) {
    throw new McpTenantInvalidError({
      cause: `tenant.arg is ${renderCauseValue(arg)}, and it has to be a plain argument name`,
    });
  }
  for (const tool of tools) {
    if (tool.name === LIST_TENANTS) throw new McpToolDuplicateError({ name: LIST_TENANTS });
    assertArgFree(arg, tool);
  }
}

/** The arg is stripped from every call, so a tool declaring it would never receive it. */
export function assertArgFree(arg: string, tool: AnyMcpTool): void {
  if (Object.hasOwn(tool.inputSchema.properties ?? {}, arg)) {
    throw new McpTenantInvalidError({
      cause: `tool ${renderCauseValue(tool.name)} declares an input property "${arg}", which tenant.arg strips from every call`,
    });
  }
}

/** `list_tenants`: the person's own tenants, nothing else — no scope, no tenant. */
export function listTenantsTool(tenant: McpTenant): AnyMcpTool {
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
      });
    },
  };
}

/** `tools/list` with the tenant arg published on every tool but `list_tenants` — never in a tool's own schema. */
export function withTenantArg(
  entries: readonly ToolListEntry[],
  arg: string,
): readonly ToolListEntry[] {
  return entries.map((entry) =>
    entry.name === LIST_TENANTS
      ? entry
      : { ...entry, inputSchema: published(entry.inputSchema, arg) },
  );
}

function published(schema: JsonSchema, arg: string): JsonSchema {
  const properties: Record<string, JsonSchema> = { ...schema.properties };
  Object.defineProperty(properties, arg, {
    value: {
      type: 'string',
      description: `The tenant this call acts in: a value from ${LIST_TENANTS}.`,
    },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return { ...schema, properties, required: [...(schema.required ?? []), arg] };
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
  const args = isRecord(rawArgs) ? rawArgs : {};
  const value = Object.hasOwn(args, tenant.arg) ? args[tenant.arg] : undefined;
  if (typeof value !== 'string' || value.length === 0) {
    return { kind: 'refused', error: new McpTenantRequiredError({ arg: tenant.arg }) };
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
