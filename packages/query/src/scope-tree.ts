// Single responsibility: a scope TREE (`@ultimat3/policy`'s `ScopeNode` — groups, `via` hops)
// as a `from()` source reads it: each condition as the `Filter` it means, the SQL text `explain`
// prints, and the in-memory check for the nodes a row alone can answer. A `via` needs its target's
// rows, which no row carries: only a provider that pushes it into `andWhereNode` answers one.

import type { ScopeCondition, ScopeNode, ScopeOperator } from '@ultimat3/policy';
import type { KindOf } from './column-kinds';
import type { Filter, FilterOp } from './shape';
import { matchesFilter } from './shape';

/**
 * Each scope operator as the `Builder` filter that means it — NULL is `= null` / `!= null`.
 * Null-prototype: `condition.op` comes from an app's policy at runtime, and a `{}` literal read
 * with it answers an `Object.prototype` member for `'constructor'` (`scripts/proto-index.ts`).
 */
const AS_FILTER: Readonly<Record<ScopeOperator, FilterOp>> = Object.assign(
  Object.create(null) as Record<ScopeOperator, FilterOp>,
  {
    eq: '=',
    neq: '!=',
    in: 'in',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    'is-null': '=',
    'is-not-null': '!=',
  },
);

/** One scope condition as the filter `.compare()` would add for it. */
export const filterOf = (condition: ScopeCondition): Filter => ({
  column: condition.column,
  op: AS_FILTER[condition.op],
  value: condition.op === 'is-null' || condition.op === 'is-not-null' ? null : condition.value,
});

/** Whether a node holds a `via` anywhere under it — the part no in-memory check can answer. */
export const hasVia = (node: ScopeNode): boolean =>
  'via' in node ||
  ('or' in node && node.or.some(hasVia)) ||
  ('and' in node && node.and.some(hasVia));

/** Whether `row` satisfies a node with no `via` in it, by the filters' own meaning. */
export const matchesNode = (row: object, node: ScopeNode, kindOf: KindOf): boolean => {
  if ('or' in node) return node.or.some((member) => matchesNode(row, member, kindOf));
  if ('and' in node) return node.and.every((member) => matchesNode(row, member, kindOf));
  if ('via' in node) return true;
  return matchesFilter(row, filterOf(node), kindOf);
};

/**
 * The node as the SQL text a `from()` source prints, each condition through `leaf` — the source's
 * own filter clause, so a node's condition reads exactly as a `.where()` does. A hop names its
 * target by entity, as entity's `andWhereNode` compiles it; `[]` in an `or` is no row.
 */
export const nodeClause = (node: ScopeNode, leaf: (filter: Filter) => string): string => {
  if ('or' in node) {
    if (node.or.length === 0) return '1 = 0';
    return `(${node.or.map((member) => nodeClause(member, leaf)).join(' or ')})`;
  }
  if ('and' in node) {
    if (node.and.length === 0) return 'true';
    return `(${node.and.map((member) => nodeClause(member, leaf)).join(' and ')})`;
  }
  if ('via' in node) {
    const inner = node.where.map((member) => nodeClause(member, leaf));
    const where = inner.length === 0 ? '' : ` where ${inner.join(' and ')}`;
    return `"${node.via.column}" in (select "${node.via.target}" from "${node.via.entity}"${where})`;
  }
  return leaf(filterOf(node));
};
