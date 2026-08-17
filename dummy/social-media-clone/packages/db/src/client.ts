// The one typed database handle. `db.posts` exists because `posts` was declared — nobody writes a
// repository class per entity, and nobody can reach a table that is not in this set.
//
// Only a feature's `repo.ts`, a query's `sql`, a migration or a seed may import this. A route or a
// component importing it is X_BOUNDARY_VIOLATION, because that is how N+1 queries end up inside a
// <head> computation and how SQL ends up where no policy guards it.

import { EnvMissingError, isLocal } from '@ultimat3/core';
import { type Driver, database, memoryDriver, postgresDriver } from '@ultimat3/entity';
import { blocks } from './schema/blocks';
import { comments } from './schema/comments';
import { conversations } from './schema/conversations';
import { credentials } from './schema/credentials';
import { friendships } from './schema/friendships';
import { likes } from './schema/likes';
import { media } from './schema/media';
import { messages } from './schema/messages';
import { notifications } from './schema/notifications';
import { participants } from './schema/participants';
import { posts } from './schema/posts';
import { sessions } from './schema/sessions';
import { users } from './schema/users';

/** The one binding that decides where rows live — here, in `x dev`, and in `ROLE=migrate`. */
const DATABASE_URL = 'DATABASE_URL';

/**
 * One driver, named rather than defaulted, so the SEED and the app write to the same store. The
 * default is a module-private memory driver nobody can reach, which is fine for a single caller
 * and wrong the moment a second one — a seed — has to populate what the first one reads.
 *
 * `DATABASE_URL` selects Postgres — which this comment claimed while the line below it read
 * `memoryDriver()` unconditionally, so every deployed container held its own copy of the world and
 * every push to main destroyed it. Four ROLE containers are four processes: the worker's write was
 * never visible to web even at one replica each, so this was never only "data is lost on redeploy".
 *
 * Unset is embedded, and that arm is not laziness: `bun test` and a bare `bun run` boot no services
 * at all, so there is no ambient client for `postgresDriver()` to send a statement to, and a demo
 * that refuses to start on a fresh clone is worse than one that forgets. Outside development and
 * test it is refused instead — the same shape, and the same reason, as `startStorage`'s
 * `LocalDiskUnsafeError` (packages/cli/src/dev-runtime.ts:161): a shipped embedded default that is
 * fine on a laptop is a silent data-loss bug in a deploy, and the deploy is where nobody is
 * watching. `docker/README.md:84` has said "never in production" since before this line was written.
 */
export const selectDriver = (env: Readonly<Record<string, string | undefined>>): Driver => {
  if ((env[DATABASE_URL] ?? '') !== '') return postgresDriver();
  if (!isLocal({ env })) {
    throw new EnvMissingError({
      cause: `${DATABASE_URL} is unset, so every row this process writes would live in its own memory and be lost on the next restart — and this is not a development environment`,
      fix: `set ${DATABASE_URL} to the Postgres url this deployment migrated (docker/docker-compose.prod.yml supplies it through .env.production), or set ULTIMATE_ENV=development to keep the embedded demo store on purpose`,
      meta: { key: DATABASE_URL },
    });
  }
  return memoryDriver();
};

export const driver = selectDriver(Bun.env);

export const db = database(
  {
    blocks,
    comments,
    conversations,
    credentials,
    friendships,
    likes,
    media,
    messages,
    notifications,
    participants,
    posts,
    sessions,
    users,
  },
  { driver },
);

export type Db = typeof db;
