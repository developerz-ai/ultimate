// The one typed database handle. `db.posts` exists because `posts` was declared — nobody writes a
// repository class per entity, and nobody can reach a table that is not in this set.
//
// Only a feature's `repo.ts`, a query's `sql`, a migration or a seed may import this. A route or a
// component importing it is X_BOUNDARY_VIOLATION, because that is how N+1 queries end up inside a
// <head> computation and how SQL ends up where no policy guards it.

import { database } from '@ultimat3/entity';
import { blocks } from './schema/blocks';
import { comments } from './schema/comments';
import { friendships } from './schema/friendships';
import { likes } from './schema/likes';
import { media } from './schema/media';
import { posts } from './schema/posts';
import { users } from './schema/users';

export const db = database({
  blocks,
  comments,
  friendships,
  likes,
  media,
  posts,
  users,
});

export type Db = typeof db;
