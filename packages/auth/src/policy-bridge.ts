// Single responsibility: turn an authenticated identity into core's `Actor`. There is exactly
// one authz system in Ultimate — `@ultimat3/policy` — and auth's only job is producing the actor
// it evaluates. Nothing downstream ever authorizes on a session row, a user row or an api key.
// `PolicyActorFields` mirrors `@ultimat3/policy`'s shape structurally so this package does not
// import a same-tier package; policy binds to it by structure, in whichever order they land.

import type { Actor } from '@ultimat3/core';
import { agentActor, anonymousActor, assertNever, serviceActor, userActor } from '@ultimat3/core';
import type { AuthApiKeyRecord, AuthSession, AuthUser } from './adapter';

/** Structural mirror of `@ultimat3/policy`'s `PolicyActorFields`. Kept in sync by hand. */
export interface PolicyActorFields {
  readonly id: string;
  readonly roles?: readonly string[] | undefined;
  /** Direct grants that bypass roles. Service tokens and break-glass accounts only. */
  readonly permissions?: readonly string[] | undefined;
  readonly orgId?: string | null | undefined;
}

export type PolicyActor = Actor & PolicyActorFields;

export interface ServiceIdentity {
  readonly id: string;
  readonly orgId?: string | null | undefined;
  readonly scopes: readonly string[];
}

/** The four `ActorKind`s, as the four things that can be holding a credential. */
export type AuthIdentity =
  | { readonly kind: 'user'; readonly user: AuthUser; readonly session: AuthSession }
  | {
      readonly kind: 'agent';
      readonly apiKey: AuthApiKeyRecord;
      /** What the key's owner may do — `null` for a key no user owns. See `actorFromApiKey`. */
      readonly ownerGrants: readonly string[] | null;
    }
  | { readonly kind: 'service'; readonly service: ServiceIdentity }
  | { readonly kind: 'anonymous' };

const withPermissions = (actor: Actor, permissions: readonly string[]): PolicyActor => ({
  ...actor,
  permissions,
});

/**
 * A human. Roles come from the row and are expanded to permissions by policy; scopes come from
 * the row too, and they are almost always empty.
 *
 * `scopes: []` used to be hardcoded here, which made a scope a thing no human could ever hold —
 * so `hasScope(actor, 'tenancy:cross')`, whose own reasons name "an admin surface listing every
 * org" and "support tooling", could only ever be satisfied by minting a `serviceActor` inside the
 * handler. That discards the operator's identity and makes the sweep unattributable, which is the
 * exact property the scope's required reason string exists to preserve.
 *
 * A session that has not satisfied an enrolled second factor resolves to an actor with no
 * roles, no permissions and no scopes rather than an error, so a half-authenticated request can
 * still reach the "finish MFA" route and nothing else. Login throws `X_MFA_REQUIRED` separately.
 */
export function actorFromUser(user: AuthUser, session: AuthSession): PolicyActor {
  const mfaPending = user.mfaSecret !== null && !session.mfaSatisfied;
  return withPermissions(
    userActor({
      id: user.id,
      orgId: user.orgId ?? undefined,
      roles: mfaPending ? [] : user.roles,
      scopes: mfaPending ? [] : user.scopes,
    }),
    mfaPending ? [] : user.permissions,
  );
}

/** `*` and `<resource>:*` — the two spellings a role uses to be granted everything. */
export const isWildcardScope = (scope: string): boolean => scope === '*' || scope.endsWith(':*');

// `@ultimat3/policy`'s own reading of a grant's resource, mirrored: same tier, so not imported.
const resourceOf = (grant: string): string => grant.split(':')[0] ?? grant;

/** Whether one of the owner's grants reaches a named permission. A grant MAY be a wildcard. */
const covers = (grant: string, wanted: string): boolean =>
  grant === '*' ||
  grant === wanted ||
  (grant.endsWith(':*') && resourceOf(grant) === resourceOf(wanted));

/**
 * What a key may carry of what it names. Two cuts, and both only ever remove:
 *
 * - a wildcard scope is dropped. `issueApiKey` refuses to mint one, and a row written before that
 *   refusal (or by hand) must not keep the reach the refusal exists to deny;
 * - a key a user OWNS keeps only the scopes that owner could exercise themselves. A key was
 *   minted with whatever list its issuer typed, so without this a member could hold a key
 *   reaching further than their own account — and it kept that reach after a demotion.
 *
 * `ownerGrants` is `null` for a key no user owns: there is nobody to be narrower than.
 */
export function apiKeyScopes(
  scopes: readonly string[],
  ownerGrants: readonly string[] | null,
): readonly string[] {
  return scopes.filter(
    (scope) =>
      !isWildcardScope(scope) &&
      (ownerGrants === null || ownerGrants.some((grant) => covers(grant, scope))),
  );
}

/**
 * An MCP/LLM caller. The actor's scopes are the key's scopes cut by `apiKeyScopes` — never the
 * owning user's roles, never a default set. An agent that can do more than its key says, or more
 * than its owner can, is the whole failure mode this bridge exists to prevent.
 */
export function actorFromApiKey(
  key: AuthApiKeyRecord,
  ownerGrants: readonly string[] | null,
): PolicyActor {
  const scopes = apiKeyScopes(key.scopes, ownerGrants);
  return withPermissions(
    agentActor({
      id: key.id,
      orgId: key.orgId ?? undefined,
      roles: [],
      scopes,
    }),
    scopes,
  );
}

/** Machine-to-machine inside the deployment. Scopes are the grant; there are no roles. */
export function actorFromService(service: ServiceIdentity): PolicyActor {
  return withPermissions(
    serviceActor({
      id: service.id,
      orgId: service.orgId ?? undefined,
      roles: [],
      scopes: service.scopes,
    }),
    service.scopes,
  );
}

/** The single funnel. Every surface resolves its caller through this and nothing else. */
export function resolveActor(identity: AuthIdentity): PolicyActor {
  switch (identity.kind) {
    case 'user':
      return actorFromUser(identity.user, identity.session);
    case 'agent':
      return actorFromApiKey(identity.apiKey, identity.ownerGrants);
    case 'service':
      return actorFromService(identity.service);
    case 'anonymous':
      return anonymousActor();
    default:
      return assertNever(identity);
  }
}
