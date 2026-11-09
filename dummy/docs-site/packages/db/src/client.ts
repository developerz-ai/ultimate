// The one typed database handle. `db.<table>` exists because the entity is in the set below —
// nobody writes a repository class per entity, and nobody can reach a table that is not listed.
//
// `x g entity` and `x g resource` add their entity to `entities`. One written by hand is the
// same two lines: its import, and `<tableName>: <entity>,` in the set.

import { storeMode } from '@ultimat3/core';
import { type Driver, database, postgresDriver, testDriver } from '@ultimat3/entity';

/**
 * One driver, NAMED rather than defaulted, and exported so a test resets the same object the app
 * reads through (`driver.reset?.()`).
 *
 * `postgresDriver()` takes no connection: it resolves `@ultimat3/db`'s process client, which is
 * the embedded PGlite under `x dev` and the `DATABASE_URL` pool in a container. Under
 * `bun test` it is `testDriver()`: memory until a test installs its migrated database with
 * `setDbClient`, that database while it is installed — decided per call, so this module-load
 * constant follows the client. `storeMode` is core's one answer to which store a seam takes.
 */
export const selectDriver = (env: Readonly<Record<string, string | undefined>>): Driver =>
  storeMode(env) === 'memory' ? testDriver() : postgresDriver();

export const driver = selectDriver(Bun.env);

/** Every entity the handle serves, keyed by the name its table takes on `db`. */
const entities = {};

/**
 * Only a feature's `repo.ts`, a `query`'s `sql` or a seed may use this. A route importing it is
 * `X_BOUNDARY_ROUTE_TO_DB`.
 */
export const db = database(entities, { driver });

export type Db = typeof db;
