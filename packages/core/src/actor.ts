// Single responsibility: who is making the request. `agent` is a first-class kind because
// every action is also an MCP tool, and MCP callers go through the same authz as humans.

/** `agent` = an MCP/LLM caller acting on behalf of a user or a service. */
export type ActorKind = 'user' | 'service' | 'agent' | 'anonymous';

export const ACTOR_KINDS = ['user', 'service', 'agent', 'anonymous'] as const;

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly orgId?: string | undefined;
  /** Application roles (`admin`, `editor`). Unrelated to the runtime `Role`. */
  readonly roles: readonly string[];
  /** Capability strings a policy can require (`post:publish`). */
  readonly scopes: readonly string[];
}

export interface ActorInit {
  readonly id: string;
  readonly orgId?: string | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
}

const ANONYMOUS: Actor = Object.freeze({
  kind: 'anonymous',
  id: 'anonymous',
  roles: Object.freeze([]),
  scopes: Object.freeze([]),
});

function build(kind: ActorKind, init: ActorInit): Actor {
  return Object.freeze({
    kind,
    id: init.id,
    orgId: init.orgId,
    roles: Object.freeze([...(init.roles ?? [])]),
    scopes: Object.freeze([...(init.scopes ?? [])]),
  });
}

export function userActor(init: ActorInit): Actor {
  return build('user', init);
}

export function serviceActor(init: ActorInit): Actor {
  return build('service', init);
}

/** An MCP or LLM caller. `orgId` and `scopes` are mandatory in practice — authz is identical. */
export function agentActor(init: ActorInit): Actor {
  return build('agent', init);
}

export function anonymousActor(): Actor {
  return ANONYMOUS;
}

export function isActorKind(value: unknown): value is ActorKind {
  return typeof value === 'string' && (ACTOR_KINDS as readonly string[]).includes(value);
}

export function isAnonymous(actor: Actor): boolean {
  return actor.kind === 'anonymous';
}

export function hasRole(actor: Actor, role: string): boolean {
  return actor.roles.includes(role);
}

export function hasScope(actor: Actor, scope: string): boolean {
  return actor.scopes.includes(scope);
}

/** Log/trace-safe identity — no email, no token, stable across surfaces. */
export function actorLabel(actor: Actor): string {
  return actor.orgId === undefined
    ? `${actor.kind}:${actor.id}`
    : `${actor.kind}:${actor.id}@${actor.orgId}`;
}
