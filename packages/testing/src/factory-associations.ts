// The two association kinds, as values a factory declares: `belongsTo` (a parent the row points
// at) and `hasMany` (children that point at the row). Both name the foreign key as a column, so the
// key a test overrides and the key the factory fills are one spelling.

import { finiteCount } from '@ultimat3/core';
import type { BelongsTo, EntityLike, FactoryLike, HasMany } from './factory-types';

export interface BelongsToOptions<TParent> {
  /** The parent column the key holds. Left out: what the child's `references()` names, else `id`. */
  readonly references?: keyof TParent & string;
}

/**
 * `belongsTo: { org: belongsTo(orgs, 'orgId') }`. `build()` builds the parent in memory, `create()`
 * writes it first; `create({ org: row })` reuses a row instead; `create({ orgId })` makes none.
 * The key is checked against the child's columns where the factory is declared.
 */
export function belongsTo<TBuilt extends object, TRow extends object, const TKey extends string>(
  parent: FactoryLike<TBuilt, TRow>,
  foreignKey: TKey,
  options: BelongsToOptions<TBuilt & TRow> = {},
): BelongsTo<TBuilt, TRow, TKey> {
  return { kind: 'belongsTo', parent, foreignKey, references: options.references };
}

export interface HasManyOptions {
  /** Children made when the call names none. Default 0: a row with children is asked for. */
  readonly count?: number;
  /** The parent column the child's key holds. Left out: the child's `references()`, else `id`. */
  readonly references?: string;
}

/**
 * `hasMany: { comments: hasMany(comments, 'postId') }` — then `create({ comments: 2 })` or
 * `create({ comments: [{ body: 'first' }, {}] })`. Made AFTER the parent, the key set from the
 * stored parent, the tenant column following it.
 */
export function hasMany<
  TBuilt extends object,
  TRow extends object,
  const TKey extends keyof TBuilt & string,
>(
  child: FactoryLike<TBuilt, TRow>,
  foreignKey: TKey,
  options: HasManyOptions = {},
): HasMany<TBuilt, TRow, TKey> {
  return {
    kind: 'hasMany',
    child,
    foreignKey,
    references: options.references,
    // Screened here, where it is written: a fraction or a NaN would surface three awaits into the
    // first `create()` as an `Array.from` throw or a loop that never runs.
    count: finiteCount(`hasMany(…, '${foreignKey}')`, 'count', options.count ?? 0),
  };
}

/** The parent property `entity`'s `foreignKey` references, read off its own `references()`. */
export function referencedBy(
  entity: EntityLike,
  foreignKey: string,
  declared: string | undefined,
): string {
  if (declared !== undefined) return declared;
  const found = entity.$references?.().find((reference) => reference.property === foreignKey);
  return found?.targetProperty ?? 'id';
}
