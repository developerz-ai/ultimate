// Single responsibility: the predicate TREE (`or`/`and` groups, `via` hops) as an author writes it,
// compiled into ordinary plan predicates. A node rides in `plan.where` as one `Predicate` whose `op`
// is not an `Operator`, so an executor that does not know it refuses the op rather than silently
// dropping the filter.

import { EntityError } from './entity-error';
import { checkedPredicate, type Operator } from './operator';
import type { Predicate } from './tenancy';

/** The pseudo-columns a group is planned under — never a property, as `$search` is not. */
export const OR_PROPERTY = '$or';
export const AND_PROPERTY = '$and';

/**
 * How deep a tree may nest, counting every `or` and `via`. A scope is a handful of conditions; a
 * tree deeper than this is a generated one, and a statement whose planner time grows with it.
 */
export const MAX_PREDICATE_DEPTH = 4;

/** A column of `Row`; any string for an untyped level (a hop's inner where), never `never`. */
export type NodeColumn<Row> = unknown extends Row ? string : Extract<keyof Row, string>;

/** One leaf, as `andWhere` takes it. */
export interface PredicateLeaf<Row = unknown> {
  readonly column: NodeColumn<Row>;
  readonly op: Operator;
  readonly value?: unknown;
}

/** Any one of its members holds. `[]` holds for no row. */
export interface PredicateOr<Row = unknown> {
  readonly or: readonly PredicateNode<Row>[];
}

/** Every member holds — the conjunction an `or` member needs (`friends AND a friend's`). `[]`: all. */
export interface PredicateAnd<Row = unknown> {
  readonly and: readonly PredicateNode<Row>[];
}

/**
 * `column in (select target from entity where …)`: the row's `column` names a row of `entity`
 * matching `where`. `entity` is the target's NAME; its tenant and its soft delete apply inside.
 */
export interface PredicateVia<Row = unknown> {
  readonly via: {
    readonly column: NodeColumn<Row>;
    readonly entity: string;
    readonly target: string;
  };
  readonly where: readonly PredicateNode[];
}

/** A tree over `Row`'s columns. A `via`'s inner `where` is over the target's, typed `unknown`. */
export type PredicateNode<Row = unknown> =
  | PredicateLeaf<Row>
  | PredicateOr<Row>
  | PredicateAnd<Row>
  | PredicateVia<Row>;

declare const scopedNode: unique symbol;

/**
 * A node a `scoped()` policy produced, handed over on `@ultimat3/query`'s `RowWindow.nodes`. Typed
 * against the policy's row where it was declared, so `andWhereNode` takes it as it takes a literal
 * tree; the brand is what keeps a hand-written untyped node from passing for one.
 */
export type ScopedNode = PredicateNode & { readonly [scopedNode]: true };

/** The planned form of a `via`, as `Predicate.value`. `where` is planned against the target. */
export interface ViaValue {
  readonly entity: string;
  readonly target: string;
  readonly where: readonly Predicate[];
}

/** The ops a node plans to: never in `OPERATORS`, so `andWhere` cannot name one. */
export type NodeOperator = 'or' | 'and' | 'via';

export const isNodeOp = (op: unknown): op is NodeOperator =>
  op === 'or' || op === 'and' || op === 'via';

/** Whether a planned predicate is an `or` or an `and` group — one walk serves both. */
export const isGroup = (predicate: Predicate): boolean =>
  predicate.op === 'or' || predicate.op === 'and';

/** The refusal for a tree no driver can answer: its shape, its depth or what a `via` names. */
export const predicateNodeInvalid = (entityName: string, detail: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_PREDICATE_NODE_INVALID',
    cause: `${entityName}: andWhereNode() was handed a tree no driver can answer — ${detail}`,
    fix: `andWhereNode({ or: [{ column, op, value }, …] })   # or { via: { column, entity, target }, where: [ … ] }: entity is a registered entity name, column and target its declared properties, at most ${MAX_PREDICATE_DEPTH} levels deep`,
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The tree as plan predicates, its shape checked on the line the author wrote. Columns are judged
 * later, by `screenPredicates`, against the entity each level is about — a `via`'s inner level is
 * the target's, which only the registry knows.
 */
export const nodePredicate = (entityName: string, node: unknown, depth = 1): Predicate => {
  if (!isRecord(node)) throw predicateNodeInvalid(entityName, 'a node is not an object');
  const group = node['or'] !== undefined ? 'or' : node['and'] !== undefined ? 'and' : undefined;
  const via = node['via'];
  if ((group !== undefined || via !== undefined) && depth > MAX_PREDICATE_DEPTH) {
    throw predicateNodeInvalid(entityName, `it nests deeper than ${MAX_PREDICATE_DEPTH} levels`);
  }
  if (group !== undefined) {
    const members = node[group];
    if (!Array.isArray(members))
      throw predicateNodeInvalid(entityName, `\`${group}\` is not a list`);
    const planned = members.map((each: unknown) => nodePredicate(entityName, each, depth + 1));
    return { column: group === 'or' ? OR_PROPERTY : AND_PROPERTY, op: group, value: planned };
  }
  if (via !== undefined) return viaPredicate(entityName, via, node['where'], depth);
  const column = node['column'];
  if (typeof column !== 'string') throw predicateNodeInvalid(entityName, 'a leaf has no column');
  return checkedPredicate(entityName, column, node['op'], node['value']);
};

const viaPredicate = (
  entityName: string,
  via: unknown,
  where: unknown,
  depth: number,
): Predicate => {
  const column = isRecord(via) ? via['column'] : undefined;
  const entity = isRecord(via) ? via['entity'] : undefined;
  const target = isRecord(via) ? via['target'] : undefined;
  if (typeof column !== 'string' || typeof entity !== 'string' || typeof target !== 'string') {
    throw predicateNodeInvalid(entityName, '`via` needs { column, entity, target }, each a string');
  }
  if (!Array.isArray(where)) throw predicateNodeInvalid(entityName, '`via.where` is not a list');
  const value: ViaValue = {
    entity,
    target,
    where: where.map((each: unknown) => nodePredicate(entity, each, depth + 1)),
  };
  return { column, op: 'via', value };
};

/** A group's members (`or` or `and`), as planned. */
export const orMembers = (predicate: Predicate): readonly Predicate[] =>
  Array.isArray(predicate.value) ? (predicate.value as readonly Predicate[]) : [];

/** A `via` predicate's planned value. Only `nodePredicate` and `via-scope.ts` build one. */
export const viaValue = (predicate: Predicate): ViaValue => predicate.value as ViaValue;
