// The one typed database handle. `db.posts` exists because `posts` was declared — nobody
// writes a repository class per entity, and nobody can reach a table that is not in the set.

import type { EntityCore } from './entity';
import type { RelatedTables } from './preload';
import type { Table } from './query';
import { tableFor } from './query';
import type { Repo } from './repo';
import { memoryRepo } from './repo';

export type EntitySet = Readonly<Record<string, EntityCore>>;

export type Database<E extends EntitySet> = {
  readonly [K in keyof E]: Table<E[K]['$row'], E[K]['$columns']>;
};

/** Where rows actually live. Postgres in production, memory in tests and before migrations. */
export interface Driver {
  repo<Row>(entity: EntityCore<Row>): Repo<Row>;
}

export interface DatabaseOptions {
  readonly driver?: Driver;
}

/**
 * The default driver: correct semantics, no database, so `x dev` and every test run before
 * the first migration exists.
 */
export const memoryDriver = (): Driver => {
  const repos = new Map<string, unknown>();
  return {
    repo<Row>(entity: EntityCore<Row>): Repo<Row> {
      const existing = repos.get(entity.$name);
      // Keyed by entity name and only ever written from that same entity, so the row type a
      // caller asks for is the one that was stored.
      if (existing !== undefined) return existing as Repo<Row>;
      const created = memoryRepo<Row>(entity);
      repos.set(entity.$name, created);
      return created;
    },
  };
};

let shared: Driver | undefined;

const defaultDriver = (): Driver => {
  shared ??= memoryDriver();
  return shared;
};

export const database = <E extends EntitySet>(
  entities: E,
  options: DatabaseOptions = {},
): Database<E> => {
  const driver = options.driver ?? defaultDriver();
  // Keyed by entity name, which is what a relation names — the object key is the caller's spelling
  // of it. This handle is the whole of what a preload can reach: a table reads the entities its own
  // `database()` call named, through the driver that call was given, so a preload against memory
  // means what a preload against Postgres means.
  const declared = new Map(Object.values(entities).map((entity) => [entity.$name, entity]));
  const related: RelatedTables = (entityName) => {
    const entity = declared.get(entityName);
    return entity === undefined ? undefined : { entity, repo: driver.repo(entity) };
  };
  const tables: Record<string, unknown> = {};
  for (const [key, entity] of Object.entries(entities)) {
    tables[key] = tableFor(entity, driver.repo(entity), related);
  }
  // Built key by key from `entities`, so each table is the one `Database<E>` names.
  return tables as Database<E>;
};
