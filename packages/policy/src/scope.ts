// A policy's second projection: `scope(actor) → where`, the predicate a read hands the database so
// the visible rows arrive as one page, index-served, instead of a JS filter over an over-fetch. The
// JS rule stays the authority and still runs on every row returned. This file declares the shape and
// attaches it; composing it into a read is `@ultimat3/query`'s, which may import both sides.
import type { Policy } from './policy';
import { markPreInput, preInputRun } from './pre-input-brand';
import type { Actor } from './roles';

/**
 * The comparisons a scope may hand down — the entity chain's `andWhere` operators that compare a
 * column to a value. Restated rather than imported: `@ultimat3/entity` is this package's tier, and a
 * sideways import is a boundaries error. Every member is one of entity's `OPERATORS`; the composer
 * in `@ultimat3/query` (tier 3, which sees both) is where that subset is pinned.
 */
export type ScopeOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is-null'
  | 'is-not-null';

/**
 * A column of the row the policy decides about; `string` for an untyped row (`keyof unknown` is
 * `never`). `NonNullable`, because a policy's row is often `Post | null` and `keyof` of a union with
 * `null` is `never` too.
 */
export type ScopeColumn<R> = unknown extends R ? string : Extract<keyof NonNullable<R>, string>;

/** One condition: entity's `Predicate` (`{ column, op, value }`), typed over the policy's row. */
export interface ScopeCondition<R = unknown> {
  readonly column: ScopeColumn<R>;
  readonly op: ScopeOperator;
  /** Absent for `is-null` / `is-not-null`; an array for `in`. Always bound, never spliced. */
  readonly value?: unknown;
}

/** Any one member holds. `[]` holds for no row — a scope that admits nobody. */
export interface ScopeOr<R = unknown> {
  readonly or: readonly ScopeNode<R>[];
}

/** Every member holds — the conjunction one arm of an `or` needs (`friends` AND a friend's). */
export interface ScopeAnd<R = unknown> {
  readonly and: readonly ScopeNode<R>[];
}

/**
 * A relation hop: the row's `column` is the `target` column of some row of `entity` (by NAME)
 * matching `where` — `author_id in (select friend_id from friendships where …)`. The inner level is
 * the target's, untyped here; its tenant and soft delete apply inside, as a read of it would.
 */
export interface ScopeVia<R = unknown> {
  readonly via: {
    readonly column: ScopeColumn<R>;
    readonly entity: string;
    readonly target: string;
  };
  readonly where: readonly ScopeNode[];
}

/**
 * One node of a scope — `@ultimat3/entity`'s `PredicateNode`, restated structurally (same tier):
 * a condition, an `or` or `and` group, or a `via` hop. At most four levels deep (entity refuses).
 */
export type ScopeNode<R = unknown> = ScopeCondition<R> | ScopeOr<R> | ScopeAnd<R> | ScopeVia<R>;

/**
 * Every node must hold — the top level is a conjunction, as the chain's `where` is. `[]` is "every
 * row" (an admin), which is not the same as a policy with no scope: that one hands NOTHING down and
 * its read stays the JS rule over whatever was read.
 *
 * `or` and `via`, decided (2026-11, reversing the AND-only decision of earlier that month): apps
 * whose visibility is a disjunction over a graph — the author, OR a friend, OR public, minus a block
 * set — over-fetched a feed and ORed in JS, which is the short page `scope` exists to end. The
 * whole scope still compiles to ONE statement (`@ultimat3/entity`'s `andWhereNode`). Where a source
 * cannot take a tree — the live matcher's flat shape, an in-memory `from()` over a `via` — the read
 * is refused (`X_QUERY_SCOPE_UNCOMPOSABLE`), never served unscoped.
 *
 * Called only for an actor the policy's own gate admitted: a caller refused before the read never
 * reaches it. Pure and synchronous, like a predicate — it runs once per read, not once per row.
 */
export type PolicyScope<R = unknown> = (actor: Actor | null) => readonly ScopeNode<R>[];

/**
 * `policy`, deciding exactly as before, carrying `scope` beside it: one definition, two projections
 * (axiom 2). The scope must admit what the rule admits; a scope that disagrees with its rule on the
 * exercise seed is a finding, never a silent short page.
 *
 * The scope belongs to the clause it is declared on. `and`, `or` and `not` build a new policy and
 * carry no scope of a child's: a conjunction of children's scopes is not the scope of `or`, and a
 * guess there would hide rows the rule admits. Scope the outermost policy, over the whole rule.
 *
 * ```ts
 * export const seePost = scoped(postRule, (actor) =>
 *   actor === null
 *     ? [{ column: 'audience', op: 'eq', value: 'public' }]
 *     : [{ column: 'orgId', op: 'eq', value: actor.orgId }],
 * );
 * ```
 */
export const scoped = <I = unknown, R = unknown>(
  policy: Policy<I, R>,
  scope: PolicyScope<R>,
): Policy<I, R> => {
  const carrying: Policy<I, R> = {
    kind: policy.kind,
    label: policy.label,
    permissions: policy.permissions,
    children: policy.children,
    run: (args, recorder, depth) => policy.run(args, recorder, depth),
    // Checked against `R` where it is written; stored as the untyped shape `Policy` holds, which
    // a generic `R` cannot be proven to fit (`ScopeColumn<R>` is deferred until `R` is known).
    scope: scope as PolicyScope,
  };
  // The before-input gate answers for the scoped policy exactly as for the one it wraps.
  return markPreInput(carrying, (args, recorder, depth) =>
    preInputRun(policy, args, recorder, depth),
  );
};

/** A node and everything under it, frozen — a caller still holding the tree cannot edit the read. */
const frozen = (node: ScopeNode): ScopeNode => {
  if ('or' in node) return Object.freeze({ or: Object.freeze(node.or.map(frozen)) });
  if ('and' in node) return Object.freeze({ and: Object.freeze(node.and.map(frozen)) });
  if ('via' in node) {
    return Object.freeze({
      via: Object.freeze({ ...node.via }),
      where: Object.freeze(node.where.map(frozen)),
    });
  }
  return Object.freeze({ ...node });
};

/**
 * The where a read composes for `actor`, frozen at every depth, or `undefined` when the policy
 * declares no scope. What `@ultimat3/query` calls — never `policy.scope` directly, so the freeze
 * cannot be skipped.
 */
export const policyScope = <I = unknown, R = unknown>(
  policy: Policy<I, R>,
  actor: Actor | null,
): readonly ScopeNode[] | undefined => {
  if (policy.scope === undefined) return undefined;
  return Object.freeze(policy.scope(actor).map(frozen));
};
