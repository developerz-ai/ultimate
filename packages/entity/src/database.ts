// The one typed database handle. `db.posts` exists because `posts` was declared — nobody
// writes a repository class per entity, and nobody can reach a table that is not in the set.

import type { EntityCore } from './entity';
import { memoryRepo } from './memory-repo';
import type { RelatedTables } from './preload';
import type { Table } from './query';
import { tableFor } from './query';
import type { Repo } from './repo';
import { observedRepo } from './row-observer';

export type EntitySet = Readonly<Record<string, EntityCore>>;

export type Database<E extends EntitySet> = {
  readonly [K in keyof E]: Table<E[K]['$row'], E[K]['$columns']>;
};

/** Where rows actually live. Postgres in production, memory in tests and before migrations. */
export interface Driver {
  repo<Row>(entity: EntityCore<Row>): Repo<Row>;
  /**
   * TEST SEAM, optional on purpose. Empties everything this driver holds, so one test's rows are
   * not the next test's fixtures. `memoryDriver()` implements it; `postgresDriver()` leaves it
   * undefined, because the rows there are an app's and a framework that could truncate them from a
   * `reset()` eventually would. A harness therefore asks and does not assume: `driver.reset?.()`.
   */
  reset?(): void;
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
  // Held separately from `repos` so the reset is a call on the repository the tables already
  // resolved, never a replacement of it.
  const resets: (() => void)[] = [];
  return {
    repo<Row>(entity: EntityCore<Row>): Repo<Row> {
      const existing = repos.get(entity.$name);
      // Keyed by entity name and only ever written from that same entity, so the row type a
      // caller asks for is the one that was stored.
      if (existing !== undefined) return existing as Repo<Row>;
      const created = memoryRepo<Row>(entity);
      repos.set(entity.$name, created);
      resets.push(() => created.reset());
      return created;
    },
    reset() {
      for (const reset of resets) reset();
    },
  };
};

let shared: Driver | undefined;

/**
 * The driver `database()` uses when a call names none — one per process, created on first use.
 *
 * Exported for ONE reason: a test harness needs the same object the app reads through, so it can
 * seed it before a test and `reset?.()` it after. Without a handle on it, a preload could only
 * build a driver of its own, and rows written into that one are invisible to every `database()`
 * call the app already made. Application code names its driver in `database(entities, { driver })`
 * or takes this one implicitly; it never asks for it by hand.
 */
export const defaultDriver = (): Driver => {
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
    // Wrapped here rather than in a driver, so a committed row change is reported the same whether
    // rows live in memory or in Postgres — `setRowObserver` is the seam, and with none installed the
    // wrapper is one comparison per write. `related` below stays unwrapped on purpose: a relation
    // preload is a READ, and a change feed has nothing to say about one.
    tables[key] = tableFor(entity, observedRepo(entity, driver.repo(entity)), related);
  }
  // Built key by key from `entities`, so each table is the one `Database<E>` names.
  return tables as Database<E>;
};
