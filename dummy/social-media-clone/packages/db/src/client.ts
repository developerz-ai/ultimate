// The one typed database handle. `db.posts` exists because `posts` was declared — nobody writes a
// repository class per entity, and nobody can reach a table that is not in this set.
//
// Only a feature's `repo.ts`, a query's `sql`, a migration or a seed may import this. A route or a
// component importing it is X_BOUNDARY_VIOLATION, because that is how N+1 queries end up inside a
// <head> computation and how SQL ends up where no policy guards it.

import { database, memoryDriver } from '@ultimat3/entity';
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

/**
 * One driver, named rather than defaulted, so the SEED and the app write to the same store. The
 * default is a module-private memory driver nobody can reach, which is fine for a single caller
 * and wrong the moment a second one — a seed — has to populate what the first one reads.
 *
 * In production `DATABASE_URL` selects the Postgres driver; this is what `x dev` and the demo use.
 */
export const driver = memoryDriver();

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
