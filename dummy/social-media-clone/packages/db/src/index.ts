// The public surface of @social-media-clone/db. Explicit — never `export *`.
//
// `db` here is the app's TYPED handle (`db.posts`, `db.users`), built by `database()` from the
// declared entity set — not @ultimat3/db's connection accessor of the same name. One name, one
// meaning: an app calls the typed handle and never reaches past it for a raw client.

export type { SqlFragment } from '@ultimat3/db';
export { sql, withTransaction } from '@ultimat3/db';
export type { Db } from './client';
export { db, driver } from './client';
// Every row type, not a subset. Three agents building on this package each hit the same wall and
// each worked around it with `typeof schema.x.$row` — a barrel that exports some of a set teaches
// callers to reach past it, which is the opposite of what an explicit public surface is for.
export type {
  Block,
  Comment,
  Conversation,
  Credential,
  Friendship,
  Like,
  Media,
  Message,
  Notification,
  Participant,
  Post,
  Session,
  User,
} from './schema';
export * as schema from './schema';
export { DEMO_LOGINS, DEMO_MARKER_IDS, demo, seedDemo, seededRowIds } from './seed';
