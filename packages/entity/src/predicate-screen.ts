// Single responsibility: refuse, at plan time, a predicate no driver can answer — so the refusal
// never depends on whether a table holds rows. Memory judged an operator only against a row, and
// answered `[]` for an unknown one on an empty table where Postgres refused; a whole money value
// compared as one column is the same shape: Postgres has no column to compare it with.

import { columnFor } from './column';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import { isOperator, operatorUnknown } from './operator';
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
