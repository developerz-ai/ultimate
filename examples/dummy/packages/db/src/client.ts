/**
 * The one typed database handle. Built from the entity set so `db.posts` exists because
 * `posts` is declared, not because someone wrote a repository class for it.
 */

import { database } from '@ultimat3/entity';
import { comments } from './schema/comments';
import { likes } from './schema/likes';
import { members } from './schema/members';
import { orgs } from './schema/orgs';
import { plans } from './schema/plans';
import { posts } from './schema/posts';

/**
 * Only a feature's `repo.ts`, a `query`'s `sql`, a migration, or a seed may use this.
 * A route or a component importing `db` is `X_BOUNDARY_VIOLATION`.
 */
export const db = database({ comments, likes, members, orgs, plans, posts });

export type Db = typeof db;
