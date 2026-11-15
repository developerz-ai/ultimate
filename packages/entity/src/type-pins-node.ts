// Compile-time pins for `andWhereNode`'s column typing — split from `type-pins.ts`, which sits at
// the file ceiling. Source, not a test: `tsc -b` never reads a `.test.ts`, so a pin there cannot fail.

import type { ReadBuilder } from './query';

/** Fails to compile when `T` is anything but `true`. */
type Assert<T extends true> = T;

/**
 * `andWhereNode` names the chain's own columns at the top and inside every `or`; a hop's inner level
 * is the target's, which the type cannot see, so it takes any string there. A misspelt top-level
 * column is a compile error, never a refusal at the first request.
 */
type NodeOf<Row> = Parameters<ReadBuilder<Row>['andWhereNode']>[0];
type NodeRow = { readonly id: string; readonly kind: string };
export type _NodeLeafNamesTheRow = Assert<
  { readonly column: 'nope'; readonly op: 'eq' } extends NodeOf<NodeRow> ? false : true
>;
export type _NodeOrNamesTheRow = Assert<
  { readonly or: readonly [{ readonly column: 'nope'; readonly op: 'eq' }] } extends NodeOf<NodeRow>
    ? false
    : true
>;
export type _NodeViaInnerTakesTheTarget = Assert<
  {
    readonly via: { readonly column: 'id'; readonly entity: string; readonly target: string };
    readonly where: readonly [{ readonly column: 'friendId'; readonly op: 'eq' }];
  } extends NodeOf<NodeRow>
    ? true
    : false
>;
