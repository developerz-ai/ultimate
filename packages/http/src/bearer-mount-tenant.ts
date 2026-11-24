// `bearerMount({ tenant })` — one token across tenants, the tenant named per call in the query
// string, never the body. The mount's authenticator asks `resolve` for the actor the token's person
// is in that tenant, and that actor IS the caller from the `auth` stage on: rate limit, policy,
// meter. Its two refusals live here too, so `errors.ts` stays under its ceiling.

import type { Actor } from '@ultimat3/core';
import { renderFixShellArg, renderThrowable } from '@ultimat3/core';
import { bearerMountInvalid, HttpError } from './errors';

/**
 * A tenant mount's call named no tenant. The fix is the caller's: the listing route every valid
 * token reaches, then the same call with the argument — `prefix` and `arg` are the app's own
 * declaration, never request text.
 */
export const bearerTenantRequired = (prefix: string, arg: string): HttpError =>
  new HttpError({
    code: 'X_BEARER_TENANT_REQUIRED',
    cause: `this mount acts every call in the tenant the call names, and the query string carries no "${arg}"`,
    fix: `curl -H 'authorization: Bearer <token>' <origin>${renderFixShellArg(prefix, '<prefix>')}/tenants   # then send the call again with ?${arg}=<one of its values>`,
  });

/**
 * `tenant.resolve` threw, or answered neither an actor nor `null`. A failed lookup is NOT "not a
 * member": a 404 would tell the caller a primitive it may call does not exist.
 */
export const bearerTenantUnresolved = (cause: string, thrown?: unknown): HttpError =>
  new HttpError({
    code: 'X_BEARER_TENANT_UNRESOLVED',
    cause: thrown === undefined ? cause : `${cause}: ${renderThrowable(thrown)}`,
    fix: 'tenant: { resolve: ({ person, value }) => actorIn(person, value) ?? null }   // in defineApi({ http: { mounts } }) — an actor, or null for a tenant the person is not in; a throw is a fault, never a non-member',
  });

/** One tenant the person may act in, as `GET <prefix>/tenants` lists it. */
export interface BearerTenantEntry {
  /** What a call sends as `?<arg>=<value>`. */
  readonly value: string;
  /** A label for whoever is choosing between them. */
  readonly name?: string;
}

/** The shape `defineAppMcp({ tenant })` takes, so an app hands one declaration to both doors. */
export interface BearerMountTenant {
  /** The query parameter every call names its tenant under — `'org'`, `'project'`. */
  readonly arg: string;
  /**
   * The actor this person acts as in tenant `value`, or `null` when they are not a member — `null`
   * answers exactly as a primitive outside the token's scopes (404). A throw is
   * `X_BEARER_TENANT_UNRESOLVED`, never read as "not a member". The answer REPLACES the person's
   * actor, so this is where a tenant's authority is narrowed.
   */
  resolve(input: {
    readonly person: Actor;
    readonly value: string;
  }): Promise<Actor | null> | Actor | null;
  /** The tenants this person may name: what `GET <prefix>/tenants` answers. */
  list(input: {
    readonly person: Actor;
  }): Promise<readonly BearerTenantEntry[]> | readonly BearerTenantEntry[];
}

/** The listing's path segment under the prefix: `GET /v1/tenants`. */
export const TENANTS_SEGMENT = '/tenants';

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A value longer than this names no tenant anyone issues; answered as a non-member, unasked. */
const MAX_TENANT_VALUE = 256;

/** Construction: the arg is a plain parameter name. */
export function assertBearerTenant(prefix: string, tenant: BearerMountTenant): void {
  const arg: unknown = tenant.arg;
  if (typeof arg !== 'string' || !ARG_NAME.test(arg)) {
    throw bearerMountInvalid(
      prefix,
      `tenant.arg is ${JSON.stringify(arg)}, and it has to be a plain query parameter name`,
    );
  }
}

/**
 * The call's actor in the tenant its query string names, or `null` for a tenant the person is not
 * in (the caller answers that as its 404). A missing tenant and a failed lookup throw.
 */
export async function tenantActorOf(
  prefix: string,
  tenant: BearerMountTenant,
  url: URL,
  person: Actor,
): Promise<Actor | null> {
  const value = url.searchParams.get(tenant.arg);
  if (value === null || value === '') throw bearerTenantRequired(prefix, tenant.arg);
  if (value.length > MAX_TENANT_VALUE) return null;
  let actor: Actor | null;
  try {
    actor = await tenant.resolve({ person, value });
  } catch (thrown) {
    throw bearerTenantUnresolved('tenant.resolve threw', thrown);
  }
  if (actor === null) return null;
  // `undefined` (a `Map.get` miss) is neither the member `null` nor an actor.
  if (typeof actor !== 'object' || typeof (actor as { kind?: unknown }).kind !== 'string') {
    throw bearerTenantUnresolved(
      'tenant.resolve answered something that is neither an actor nor null',
    );
  }
  return actor;
}

/** The listing's body: the person's own tenants, nothing else. */
export async function tenantListing(
  tenant: BearerMountTenant,
  person: Actor,
): Promise<{ readonly tenants: readonly BearerTenantEntry[] }> {
  const listed = await tenant.list({ person });
  return {
    tenants: listed.map((entry) => ({
      value: entry.value,
      ...(entry.name === undefined ? {} : { name: entry.name }),
    })),
  };
}
