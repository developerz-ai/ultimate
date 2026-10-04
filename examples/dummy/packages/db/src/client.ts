/**
 * The one typed database handle. Built from the entity set so `db.posts` exists because
 * `posts` is declared, not because someone wrote a repository class for it.
 */

import { storeMode } from '@ultimat3/core';
import { type Driver, database, memoryDriver, postgresDriver } from '@ultimat3/entity';
import { comments } from './schema/comments';
import { connections } from './schema/connections';
import { likes } from './schema/likes';
import { members } from './schema/members';
import { orgs } from './schema/orgs';
import { plans } from './schema/plans';
import { posts } from './schema/posts';
import { runEvents } from './schema/run-events';
import { runs } from './schema/runs';

/**
 * One driver, NAMED rather than defaulted, and exported so the test preload seeds through the same
 * object the app reads through.
 *
 * `database()` with no second argument resolves `defaultDriver()`, a module-private
 * `memoryDriver()` shared by every caller that also names none. This app called it that way until
 * 2026-08-23 (#270), and the two callers that matter did NOT agree: `x db seed dev` runs
 * `postgresDriver()` (`packages/cli/src/cmd-db.ts`, `runSeed`), so it wrote to the embedded PGlite
 * `x dev` boots, while the app read a process-private memory driver that had never seen a row. The
 * README promised "embedded Postgres" and this app had never read a row out of one.
 *
 * `postgresDriver()` takes no connection: it resolves `@ultimat3/db`'s process client, which is
 * PGlite under `x dev` and the `DATABASE_URL` pool in a container. So one arm covers dev, the
 * migrate role and every serving role, and a process with neither gets `X_DB_UNAVAILABLE` naming
 * both — loud, not silent.
 *
 * `test` is the one carve-out and it is not laziness: `bun test` installs no client, so a
 * statement would have nothing to reach. Core's `storeMode` is that rule, written once: it reads
 * `ULTIMATE_ENV` then `NODE_ENV`, and `bun test` sets the second to `test`.
 */
export const selectDriver = (env: Readonly<Record<string, string | undefined>>): Driver =>
  storeMode(env) === 'memory' ? memoryDriver() : postgresDriver();

export const driver = selectDriver(Bun.env);

/**
 * The entity set, named so `x g entity` has a list to add to: the generator edits THIS literal
 * (`X_DB_HANDLE_UNREGISTERED` when it finds none), and a handle built from an inline object gave
 * it nothing to find.
 */
const entities = { comments, connections, likes, members, orgs, plans, posts, runEvents, runs };

/**
 * Only a feature's `repo.ts`, a `query`'s `sql`, a migration, or a seed may use this.
 * A route or a component importing `db` is `X_BOUNDARY_VIOLATION`.
 */
export const db = database(entities, { driver });

export type Db = typeof db;
