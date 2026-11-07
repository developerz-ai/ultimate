// One call's tenant: the mechanism that lets one agent token drive an app that is home to many
// orgs. `agentActor()` rebuilds the token's actor once per CONNECTION; a tenant is a per-CALL
// fact the caller states, so it happens here, after connection setup and before anything reads
// the call — the caller's tenancy stays the app's knowledge (`resolve`), never the server's.
//
// Not-a-member IS not-found (`X_MCP_NOT_FOUND` through the normal path): a separate "unknown
// tenant" error would let anyone enumerate rented orgs. Membership check, arg eviction and the
// rebuild live together in this file so no surface can strip the arg without doing the rest.

import type { Actor } from '@ultimat3/core';

/** The one fact the rebuilt actor must carry: the org this call runs for. */
export interface McpTenantMembership {
  readonly orgId: string;
}

/**
 * How a server serves one token across many tenants. `arg` is the input-key the caller names the
 * tenant with — kept OUT of every tool's published schema so no tool ever knows tenancy exists.
 */
export interface McpTenantOption {
  /** The input-key carrying the tenant, e.g. `'tenant'`. Evicted before schema validation. */
  readonly arg: string;
  /**
   * The app's membership lookup for ONE actor: the membership record for `tenantArg`, or
   * `undefined`. `undefined` is deliberately the not-a-member answer — a separate error would be
   * an enumeration oracle over every org the app hosts.
   */
  resolve(
    actor: Actor,
    tenantArg: string,
  ): Promise<McpTenantMembership | undefined> | McpTenantMembership | undefined;
}

/**
 * Evict the tenant arg from `rawArgs` BEFORE schema validation, so no tool's input schema — and no
 * `invalid-args` refusal — ever has to model it. Returns the raw value (untyped: `resolve` is
 * whoever knows what a tenant id looks like) plus the rest of the arguments.
 */
export function stripTenantArgs(
  rawArgs: Readonly<Record<string, unknown>> | undefined,
  option: McpTenantOption,
): { value: unknown; rest: Record<string, unknown> } {
  if (rawArgs === undefined) return { value: undefined, rest: {} };
  const { [option.arg]: value, ...rest } = rawArgs;
  return { value, rest };
}

/**
 * Rebuild the per-call actor: same `agent` identity, same id, roles, scopes, permissions and
 * preferences, the tenant's orgId in place of the token's. Frozen, like every actor — a mutable
 * one would let one call's handler rewrite the next call's authority. Only an `agent` actor may
 * be re-tenanted: a human or service actor is not a token to be re-pointed at a different org.
 */
export function buildTenantActor(actor: Actor, membership: McpTenantMembership): Actor {
  if (actor.kind !== 'agent') {
    throw new TypeError(`buildTenantActor: only agents carry tenants, got kind '${actor.kind}'`);
  }
  return Object.freeze({
    ...actor,
    orgId: membership.orgId,
  }) as Actor;
}
