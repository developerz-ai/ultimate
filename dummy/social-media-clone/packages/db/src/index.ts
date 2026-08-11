// The public surface of @social-media-clone/db. Explicit — never `export *`.
//
// `db` here is the app's TYPED handle (`db.posts`, `db.users`), built by `database()` from the
// declared entity set — not @ultimat3/db's connection accessor of the same name. One name, one
// meaning: an app calls the typed handle and never reaches past it for a raw client.

export type { SqlFragment } from '@ultimat3/db';
export { sql, withTransaction } from '@ultimat3/db';
export type { Db } from './client';
export { db } from './client';
export type { Block, Comment, Friendship, Like, Media, Post, User } from './schema';
export * as schema from './schema';
