// Single responsibility: what `references(() => posts.id, { countedIn: () => posts.likeCount })`
// means once both schema modules have evaluated — the parent column resolved, held to being an
// integer of the entity the key points at, and projected for `@ultimat3/db` (which emits the
// trigger) and for the memory driver (which mirrors it).

import type { CounterDescriptionLike } from '@ultimat3/db';
import { bindingOf, columnName } from './column';
import type { EntityCore } from './entity';
import { SOFT_DELETE_COLUMN } from './entity';
import { EntityError } from './errors';
import { getEntity, registeredEntities, registryGeneration } from './registry';
import type { AnyColumn } from './types';

/** One resolved counter: both entities, both properties. */
export interface Counter {
  readonly parent: EntityCore;
  /** The counting integer's property on the parent. */
  readonly column: string;
  readonly child: EntityCore;
  /** The child's foreign-key property. */
  readonly references: string;
}

const countsInvalid = (entity: string, property: string, reason: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_COUNTS_INVALID',
    cause: `${entity}.${property} declares countedIn, and ${reason}`,
    fix: `x db gen "count"   # after ${property}: uuid().references(() => <parent>.id, { countedIn: () => <parent>.<count> }) in entity('${entity}'), where <count> is integer().default(0)`,
  });

/** The counter one child key declares, resolved and checked. `null` when it declares none. */
export function counterOf(child: EntityCore, property: string, column: AnyColumn): Counter | null {
  const target = column.$meta.countedIn;
  if (target === undefined) return null;
  const counting = target();
  const binding = bindingOf(counting);
  const parent = binding === undefined ? undefined : getEntity(binding.table)?.core;
  if (binding === undefined || parent === undefined) {
    throw countsInvalid(child.$name, property, 'its countedIn column belongs to no entity');
  }
  if (counting.$meta.kind !== 'integer') {
    throw countsInvalid(
      child.$name,
      property,
      `${binding.table}.${binding.property} is no integer()`,
    );
  }
  // `NULL + 1` is NULL in the trigger and memory counts from 0: a nullable count means two things.
  if (!counting.$meta.notNull) {
    throw countsInvalid(child.$name, property, `${binding.table}.${binding.property} is nullable`);
  }
  const points =
    column.$meta.references === undefined ? undefined : bindingOf(column.$meta.references());
  const key = parent.$primaryKey.length === 1 ? parent.$primaryKey[0] : undefined;
  if (points?.table !== parent.$name || points.property !== key) {
    throw countsInvalid(
      child.$name,
      property,
      `it is no foreign key to ${parent.$name}'s single primary key, so it cannot count into it`,
    );
  }
  return { parent, column: binding.property, child, references: property };
}

let cached: { readonly generation: number; readonly counters: readonly Counter[] } | undefined;

/**
 * Every counter declared on the keys of every registered entity — memoised on
 * `registryGeneration()` as `relationMap()` is, because the memory driver asks on every write.
 */
export function registeredCounters(): readonly Counter[] {
  const generation = registryGeneration();
  if (cached?.generation === generation) return cached.counters;
  const counters = registeredEntities().flatMap((entry) => {
    const child = entry.core;
    if (child === undefined) return [];
    return Object.entries(child.$columns).flatMap(([property, column]) => {
      const counter = counterOf(child, property, column);
      return counter === null ? [] : [counter];
    });
  });
  cached = { generation, counters };
  return counters;
}

/** The counters kept ON `parent`'s columns. */
export const countersOf = (parent: EntityCore): readonly Counter[] =>
  registeredCounters().filter((counter) => counter.parent.$name === parent.$name);

/** The counters whose CHILD is `entity`: what a write to it must move. */
export const countersTargeting = (entity: string): readonly Counter[] =>
  registeredCounters().filter((counter) => counter.child.$name === entity);

const physical = (entity: EntityCore, property: string): string => {
  const column = entity.$columns[property];
  return column === undefined ? property : columnName(property, column.$meta);
};

/** The projection `@ultimat3/db` compiles to a trigger on the child. */
export function describeCounter(counter: Counter): CounterDescriptionLike {
  const key = counter.parent.$primaryKey[0] ?? '';
  return {
    column: physical(counter.parent, counter.column),
    key: physical(counter.parent, key),
    table: counter.child.$table,
    references: physical(counter.child, counter.references),
    softDelete: counter.child.$softDelete ? physical(counter.child, SOFT_DELETE_COLUMN) : null,
  };
}
