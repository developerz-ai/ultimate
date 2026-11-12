// The four key parts one `indexes:` entry may declare past a column list — an expression key, a
// direction per key, INCLUDE payload, an operator class — checked where the author wrote them and
// resolved to physical names. `@ultimat3/db` (`index-key-ddl.ts`) renders them and refuses again.

import type { IndexOperatorClass } from '@ultimat3/db';
import { invariantViolated } from './errors';
import type { Resolve } from './expr';
import type { IndexInit } from './index-init';
import type { ColumnMap } from './types';

/** The declared parts, physical, each absent unless written — the `IndexDef` fields they become. */
export interface DeclaredKeyParts {
  readonly expression?: string;
  readonly orders?: readonly ('asc' | 'desc' | null)[];
  readonly include?: readonly string[];
  readonly operatorClass?: IndexOperatorClass;
}

const DIRECTIONS: ReadonlySet<unknown> = new Set(['asc', 'desc', null]);

/**
 * Every rule Postgres has for the four, refused at `entity()` with `X_INVARIANT_VIOLATED` — the
 * code a bad `on:` or `where:` already raises — rather than at `x db gen` or as the server's own
 * syntax error inside `ROLE=migrate`, which names none of the entity.
 */
export const declaredKeyPartsOf = <C extends ColumnMap>(
  entityName: string,
  index: IndexInit<C>,
  resolve: Resolve,
): DeclaredKeyParts => {
  const on = `the index on (${index.on.join(', ')})`;
  const refuse = (detail: string): never => {
    throw invariantViolated(entityName, 'index', `${on} ${detail}`);
  };
  const btree = index.using === undefined || index.using === 'btree';
  const { expression, orders, include, operatorClass } = index;
  if (expression !== undefined && expression.trim() === '') {
    refuse("declares a blank expression — write the key, e.g. expression: 'lower(email)'");
  }
  if (orders !== undefined) {
    if (index.order !== undefined)
      refuse('declares both order and orders — orders states every key; drop order');
    if (!btree) refuse(`declares orders on a ${index.using} index — only a btree orders its keys`);
    const keys = expression === undefined ? index.on.length : 1;
    if (orders.length !== keys) {
      refuse(`declares ${orders.length} direction(s) for ${keys} key(s) — orders is one per key`);
    }
    if (!orders.every((direction) => DIRECTIONS.has(direction))) {
      refuse("declares a direction other than 'asc', 'desc' or null");
    }
  }
  if (include !== undefined) {
    if (!btree) refuse(`declares include on a ${index.using} index — INCLUDE is btree only`);
    if (include.length === 0) refuse('declares an empty include — name a column, or drop include');
  }
  if (operatorClass !== undefined && index.using !== 'gin') {
    refuse(`declares ${operatorClass} without using: 'gin' — it is a gin operator class`);
  }
  return {
    ...(expression === undefined ? {} : { expression }),
    ...(orders === undefined ? {} : { orders }),
    ...(include === undefined ? {} : { include: include.map((property) => resolve([property])) }),
    ...(operatorClass === undefined ? {} : { operatorClass }),
  };
};
