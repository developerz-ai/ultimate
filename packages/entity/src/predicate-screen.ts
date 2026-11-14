// Single responsibility: refuse, at plan time, a predicate no driver can answer — so the refusal
// never depends on whether a table holds rows. Memory judged an operator only against a row, and
// answered `[]` for an unknown one on an empty table where Postgres refused; a whole money value
// compared as one column is the same shape: Postgres has no column to compare it with. A predicate
// TREE (`predicate-node.ts`) is screened level by level, each against the entity it is about.

import { columnFor } from './column';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import { isOperator, operatorUnknown } from './operator';
import { orMembers, predicateNodeInvalid, viaValue } from './predicate-node';
import { getEntity } from './registry';
import { sealedFields } from './sealed';
import type { Predicate } from './tenancy';

/** A NULL test on a whole money property asks about its amount (`pg-sql.ts` `nullTestPath`). */
const isNullTest = (predicate: Predicate): boolean =>
  predicate.op === 'is-null' ||
  predicate.op === 'is-not-null' ||
  ((predicate.op === 'eq' || predicate.op === 'neq') && predicate.value === null);

export const screenPredicates = <Row>(
  entity: EntityCore<Row>,
  where: readonly Predicate[],
): void => {
  for (const predicate of where) {
    if (predicate.op === 'or') {
      screenPredicates(entity, orMembers(predicate));
      continue;
    }
    if (predicate.op === 'via') {
      screenVia(entity, predicate);
      continue;
    }
    if (!isOperator(predicate.op)) {
      throw operatorUnknown(entity.$name, predicate.column, predicate.op);
    }
    const column = columnFor(entity.$columns, predicate.column);
    if (column?.$meta.kind === 'money' && !isNullTest(predicate)) {
      const property = predicate.column;
      throw invariantViolated(
        entity.$name,
        property,
        `${property} is money: name ${property}.minor or ${property}.currency`,
      );
    }
  }
};

/**
 * The entity a `via` reads, resolved from the registry by NAME. Exported for the two places that
 * compile one: the subselect is built against this entity's own table, columns and soft delete.
 */
export const viaTarget = (source: EntityCore, predicate: Predicate): EntityCore => {
  const { entity: name } = viaValue(predicate);
  const target = getEntity(name)?.core;
  if (target === undefined) {
    throw predicateNodeInvalid(source.$name, `via names entity '${name}', which is not registered`);
  }
  return target;
};

/**
 * A `via` names two declared columns, neither of them sealed — a sealed value is ciphertext and the
 * hop would compare it to a plaintext the source never stores — and its inner level is screened as
 * the target's. Sealed columns are refused INSIDE it too: the target's sealing seam is not on this
 * read, so nothing would rewrite them.
 */
const screenVia = <Row>(entity: EntityCore<Row>, predicate: Predicate): void => {
  const source = entity as EntityCore;
  const target = viaTarget(source, predicate);
  const { target: targetColumn, where } = viaValue(predicate);
  const named = (owner: EntityCore, column: string): void => {
    if (columnFor(owner.$columns, column) === undefined) {
      throw predicateNodeInvalid(source.$name, `via names ${owner.$name}.${column}, no declared column`);
    }
    if (sealedFields(owner).some((field) => field.property === column)) {
      throw predicateNodeInvalid(source.$name, `via names ${owner.$name}.${column}, a sealed column`);
    }
  };
  named(source, predicate.column);
  named(target, targetColumn);
  for (const column of leafColumns(where)) named(target, column);
  screenPredicates(target, where);
};

/** Every real column a level names, through its `or` groups but not into a nested `via`. */
const leafColumns = (where: readonly Predicate[]): readonly string[] =>
  where.flatMap((predicate) =>
    predicate.op === 'or'
      ? leafColumns(orMembers(predicate))
      : predicate.op === 'via'
        ? [predicate.column]
        : [predicate.column.split('.')[0] ?? predicate.column],
  );
