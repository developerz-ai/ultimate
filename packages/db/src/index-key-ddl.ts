// Single responsibility: an index's KEYS past a plain column list — an expression key, a direction
// per key, INCLUDE payload columns, the trigram operator class — as statement text, plus the shape
// parts and the extension they add. Split from `index-ddl.ts`, which assembles the statement.
// Every part is optional, and absent writes and hashes exactly what it did before it existed.

import { assert, describeValue } from '@ultimat3/core';
import type { IndexDescriptionLike } from './entity-shape';
import { DbError } from './errors';
import { identifier } from './sql';
import { statementsOf } from './statement-split';

/**
 * One member, deliberately — `index-method.ts`'s rule: `gin_trgm_ops` has a caller (`contains`,
 * `like '%x%'`, which no btree serves) and every other class would be a rule with no test.
 */
export const INDEX_OPERATOR_CLASSES = ['gin_trgm_ops'] as const;

export type IndexOperatorClass = (typeof INDEX_OPERATOR_CLASSES)[number];

/** The four parts as one optional bag — what both sides of a comparison and a snapshot carry. */
export interface IndexKeyParts {
  readonly expression?: string | undefined;
  readonly orders?: readonly ('asc' | 'desc' | null)[] | undefined;
  readonly include?: readonly string[] | undefined;
  readonly operatorClass?: string | undefined;
}

/** `X_SQL_UNSAFE`, `indexOrderInvalid`'s reasoning: each value is SPLICED into the statement. */
const keyUnsafe = (index: string, what: string, fix: string): DbError =>
  new DbError({ code: 'X_SQL_UNSAFE', cause: `index "${index}": ${what}`, fix, meta: { index } });

/** Re-derived from the closed set, never spliced — the input crossed the tier seam untyped. */
function directionSql(index: string, order: unknown): string {
  if (order === null) return '';
  if (order === 'asc') return ' asc';
  if (order === 'desc') return ' desc';
  throw keyUnsafe(
    index,
    `a key direction must be 'asc', 'desc' or null; got ${describeValue(order)}`,
    `indexes: [{ on: ['a', 'b'], orders: [null, 'desc'] }]   # then x db gen`,
  );
}

function operatorClassSql(index: IndexDescriptionLike): string {
  const { operatorClass } = index;
  if (operatorClass === undefined) return '';
  if (operatorClass !== 'gin_trgm_ops') {
    throw keyUnsafe(
      index.name,
      `an operator class must be 'gin_trgm_ops'; got ${describeValue(operatorClass)}`,
      `indexes: [{ on: ['name'], using: 'gin', operatorClass: 'gin_trgm_ops' }]   # then x db gen`,
    );
  }
  assert(
    index.using === 'gin',
    `index "${index.name}" declares gin_trgm_ops on a ${index.using ?? 'btree'} index; it is a gin operator class`,
    `indexes: [{ on: ['<column>'], using: 'gin', operatorClass: 'gin_trgm_ops' }]`,
  );
  return ' gin_trgm_ops';
}

/** The key list as SQL, without its parentheses. `fallback` is the single `order` direction. */
export function indexKeysSql(index: IndexDescriptionLike, fallback: string): string {
  const keys = index.expression === undefined ? [...index.columns] : [index.expression];
  if (index.expression !== undefined) {
    const commands = statementsOf(index.expression).length;
    if (commands > 1) {
      throw keyUnsafe(
        index.name,
        `the expression holds ${String(commands)} commands; an index key is one expression`,
        `indexes: [{ on: ['email'], expression: 'lower(email)' }]   # one expression, then x db gen`,
      );
    }
  }
  const { orders } = index;
  if (orders !== undefined) {
    assert(
      index.order === null,
      `index "${index.name}" declares both order and orders; orders states every key's direction`,
      `indexes: [{ on: ['a', 'b'], orders: ['desc', 'desc'] }]   # drop order`,
    );
    assert(
      orders.length === keys.length,
      `index "${index.name}" has ${String(keys.length)} keys and ${String(orders.length)} directions`,
      `indexes: [{ on: ['a', 'b'], orders: [null, 'desc'] }]   # one direction per key`,
    );
    assert(
      (index.using ?? 'btree') === 'btree',
      `index "${index.name}" is ${String(index.using)} and orders its keys; only a btree orders its keys`,
      `indexes: [{ on: ['<column>'] }]   # drop orders, or drop using`,
    );
  }
  const opclass = operatorClassSql(index);
  return keys
    .map((key, position) => {
      const head = index.expression === undefined ? identifier(key).text : `(${key})`;
      const direction =
        orders === undefined ? fallback : directionSql(index.name, orders[position]);
      return `${head}${opclass}${direction}`;
    })
    .join(', ');
}

/** ` include ("a", "b")`, or `''`. Postgres stores it in btree, gist and spgist; this set has btree. */
export function indexIncludeSql(index: IndexDescriptionLike): string {
  if (index.include === undefined || index.include.length === 0) return '';
  assert(
    (index.using ?? 'btree') === 'btree',
    `index "${index.name}" is ${String(index.using)} and declares include; Postgres has no INCLUDE on it`,
    `indexes: [{ on: ['<column>'], include: ['<column>'] }]   # drop using, or drop include`,
  );
  return ` include (${index.include.map((column) => identifier(column).text).join(', ')})`;
}

/** The extension an index needs before it can be built — `null` for every index but a trigram one. */
export const requiredExtension = (index: IndexKeyParts): string | null =>
  index.operatorClass === 'gin_trgm_ops' ? 'pg_trgm' : null;

/** Only the parts present, so an index declaring none hashes exactly as it did before them. */
export function indexKeyShape(index: IndexKeyParts): readonly unknown[] {
  const parts: unknown[] = [];
  if (index.expression !== undefined) parts.push({ expression: index.expression });
  if (index.orders !== undefined) parts.push({ orders: [...index.orders] });
  if (index.include !== undefined && index.include.length > 0) {
    parts.push({ include: [...index.include] });
  }
  if (index.operatorClass !== undefined) parts.push({ operatorClass: index.operatorClass });
  return parts;
}

/** True when any part is present — none of them can be what a UNIQUE constraint built. */
export const hasKeyParts = (index: IndexKeyParts): boolean => indexKeyShape(index).length > 0;

type DeclaredKeyParts = Pick<
  IndexDescriptionLike,
  'expression' | 'orders' | 'include' | 'operatorClass'
>;

/**
 * A RECORDED index's parts as a declaration this generator can emit again — `declaredMethod`'s
 * rule: the recorded side is typed open, and a class this generator cannot write is refused rather
 * than rebuilt without it. Each part only when present, so absent stays absent.
 */
export function declaredKeyParts(name: string, index: IndexKeyParts): DeclaredKeyParts {
  const { operatorClass } = index;
  if (operatorClass !== undefined && operatorClass !== 'gin_trgm_ops') {
    throw keyUnsafe(
      name,
      `an operator class must be 'gin_trgm_ops'; got ${describeValue(operatorClass)}`,
      `indexes: [{ on: ['name'], using: 'gin', operatorClass: 'gin_trgm_ops' }]   # then x db gen`,
    );
  }
  return {
    ...(index.expression === undefined ? {} : { expression: index.expression }),
    ...(index.orders === undefined ? {} : { orders: [...index.orders] }),
    ...(index.include === undefined ? {} : { include: [...index.include] }),
    ...(operatorClass === undefined ? {} : { operatorClass }),
  };
}
