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
  | { readonly kind: 'agent'; readonly apiKey: AuthApiKeyRecord }
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

/**
 * An MCP/LLM caller. The actor's scopes are **exactly** the key's scopes — never the owning
 * user's roles, never a default set. An agent that can do more than its key says is the whole
 * failure mode this bridge exists to prevent.
 */
export function actorFromApiKey(key: AuthApiKeyRecord): PolicyActor {
  return withPermissions(
    agentActor({
      id: key.id,
      orgId: key.orgId ?? undefined,
      roles: [],
      scopes: key.scopes,
    }),
    key.scopes,
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
      return actorFromApiKey(identity.apiKey);
    case 'service':
      return actorFromService(identity.service);
    case 'anonymous':
      return anonymousActor();
    default:
      return assertNever(identity);
  }
}
