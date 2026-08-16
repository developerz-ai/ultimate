// Single responsibility: who is making the request. `agent` is a first-class kind because
// every action is also an MCP tool, and MCP callers go through the same authz as humans.
//
// `ActorFacts` is the extension seam: an app declares its own authz facts once, by module
// augmentation, and they ride on the SAME actor every surface already hands the policy layer —
// so a relational rule ("a friend of the author") never needs a second authz path.

/** `agent` = an MCP/LLM caller acting on behalf of a user or a service. */
export type ActorKind = 'user' | 'service' | 'agent' | 'anonymous';

export const ACTOR_KINDS = ['user', 'service', 'agent', 'anonymous'] as const;

/**
 * **The channel for every app-specific fact about who is calling.** `Actor` itself carries only
 * what every app has — `kind`, `id`, `orgId`, `roles`, `scopes` — and it never grows a field for
 * one app's vocabulary. A `memberId`, a `tz`, a plan tier, the friend set, the block set, the org
 * row: each is declared here, by module augmentation, and resolved ONCE per request, because a
 * policy predicate is synchronous and may not query.
 *
 * ```ts
 * declare module '@ultimat3/core' {
 *   interface ActorFacts {
 *     readonly memberId: string;
 *     readonly tz: string;
 *     readonly viewer: Viewer;
 *   }
 * }
 * ```
 *
 * Then `withFacts(actor, { memberId, tz })` at the request boundary and `actorFact(actor,
 * 'memberId')` everywhere else. Do not thread a second identity object beside the actor and do
 * not ask for a field on `Actor`/`ActorInit`: a fact declared here rides the SAME actor every
 * surface already hands the policy layer, so a relational rule never needs a second authz path.
 *
 * Same shape as `CtxServices` and `PermissionRegistry`, for the same reason: the app declares
 * once and every reader — predicate, action handler, component — is typed from that declaration
 * without a single surface package learning the app's vocabulary.
 */
export interface ActorFacts {
  /** Phantom member; never augment or read this key. */
  readonly __ultimate?: never;
}

/**
 * Generic over the interface so `type-pins.ts` can instantiate the machinery against a sample
 * fact set. Augmenting `ActorFacts` inside the framework would declare that fact for every app.
 */
export type FactKeysOf<F> = Exclude<keyof F, '__ultimate'>;

export type FactMapOf<F> = { readonly [K in FactKeysOf<F>]?: F[K] | undefined };

export type ActorFactKey = FactKeysOf<ActorFacts>;

/**
 * Every declared fact, each independently absent.
 *
 * Optional per key, and that is the load-bearing decision: nothing can prove a fact was
 * resolved — an actor is also minted by a test, a job runner and an MCP token exchange — so an
 * unresolved fact reads as `undefined` and a predicate must branch on it. An absent fact is not
 * a satisfied one, and here that is a type error rather than a convention.
 */
export type ActorFactMap = FactMapOf<ActorFacts>;

/**
 * Who is REALLY acting, when the effective actor is someone else. Two fields, both bounded and
 * both already log-safe — a support engineer's id and kind, never their email or name.
 */
export interface ActorOrigin {
  readonly actorId: string;
  readonly actorKind: ActorKind;
}

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly orgId?: string | undefined;
  /** Application roles (`admin`, `editor`). Unrelated to the runtime `Role`. */
  readonly roles: readonly string[];
  /** Capability strings a policy can require (`post:publish`). */
  readonly scopes: readonly string[];
  /** App-declared facts. Read it through `actorFact()`; never logged — `actorLabel` is id-only. */
  readonly facts?: ActorFactMap | undefined;
  /**
   * Set by `impersonate()`. Its absence is a positive statement — this actor is acting for
   * themselves — which is what makes a refund issued during impersonation distinguishable from
   * one the customer issued. Every surface that renders an actor renders this with it.
   */
  readonly onBehalfOf?: ActorOrigin | undefined;
}

export interface ActorInit {
  readonly id: string;
  readonly orgId?: string | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly facts?: ActorFactMap | undefined;
  /** For a session that already recorded an impersonation; `impersonate()` sets it otherwise. */
  readonly onBehalfOf?: ActorOrigin | undefined;
}

const NO_FACTS: ActorFactMap = Object.freeze({});

const ANONYMOUS: Actor = Object.freeze({
  kind: 'anonymous',
  id: 'anonymous',
  roles: Object.freeze([]),
  scopes: Object.freeze([]),
  facts: NO_FACTS,
});

function build(kind: ActorKind, init: ActorInit): Actor {
  return Object.freeze({
    kind,
    id: init.id,
    orgId: init.orgId,
    roles: Object.freeze([...(init.roles ?? [])]),
    scopes: Object.freeze([...(init.scopes ?? [])]),
    facts: Object.freeze({ ...init.facts }),
    onBehalfOf: init.onBehalfOf === undefined ? undefined : Object.freeze({ ...init.onBehalfOf }),
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

/**
 * Attach resolved facts to an actor, once, at the request boundary — the one place that already
 * awaited the database. Returns a new frozen actor, so the actor a predicate reads later cannot
 * be edited under it; later facts win over earlier ones for the same key.
 */
export function withFacts(actor: Actor, facts: ActorFactMap): Actor {
  return Object.freeze({ ...actor, facts: Object.freeze({ ...actor.facts, ...facts }) });
}

/**
 * The one way to read a declared fact. Takes `Actor | null` because that is exactly what a policy
 * predicate is handed, and returns `undefined` for an anonymous, absent or unresolved actor —
 * which is what makes "absent fact" a denial by construction rather than by review.
 */
export function actorFact<K extends ActorFactKey>(
  actor: Actor | null | undefined,
  key: K,
): ActorFacts[K] | undefined {
  return actor?.facts?.[key];
}

/** The origin tuple for an actor, for stamping onto whoever they go on to impersonate. */
export function actorOrigin(actor: Actor): ActorOrigin {
  return Object.freeze({ actorId: actor.id, actorKind: actor.kind });
}

/**
 * Log/trace-safe identity — no email, no token, stable across surfaces. Under impersonation it
 * renders `service:eng-7→user:cust-99@org-3`: the real actor, an arrow, the effective one. One
 * string, so no reader of a log line, a span or an audit row can see the second half alone.
 */
export function actorLabel(actor: Actor): string {
  const base =
    actor.orgId === undefined
      ? `${actor.kind}:${actor.id}`
      : `${actor.kind}:${actor.id}@${actor.orgId}`;
  return actor.onBehalfOf === undefined
    ? base
    : `${actor.onBehalfOf.actorKind}:${actor.onBehalfOf.actorId}→${base}`;
}
