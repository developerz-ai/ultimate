// The public surface of @social-media-clone/db: every entity the app hands out, by name. NOT
// what the migration generator reads — `x db gen` diffs the entity REGISTRY, which `loadApp`
// fills by importing `packages/*/src/**` directly, so an entity missing from this list still
// reaches the database. What it decides is what the rest of the app can import.
//
// Explicit re-exports, never `export *`: the public surface of a package is a decision, not a
// side effect of what happens to live in a directory.

export type { Block } from './schema/blocks';
export { blocks } from './schema/blocks';
export type { Comment } from './schema/comments';
export { comments } from './schema/comments';
export type { Conversation } from './schema/conversations';
export { CONVERSATION_KINDS, conversations } from './schema/conversations';
export type { Credential } from './schema/credentials';
export { credentials } from './schema/credentials';
export type { Friendship } from './schema/friendships';
export { friendships } from './schema/friendships';
export type { Like } from './schema/likes';
export { likes } from './schema/likes';
export type { Media } from './schema/media';
export { media } from './schema/media';
export type { Message } from './schema/messages';
export { messages } from './schema/messages';
export type { Notification } from './schema/notifications';
export { NOTIFICATION_KINDS, notifications } from './schema/notifications';
export type { Participant } from './schema/participants';
export { participants } from './schema/participants';
export type { Post } from './schema/posts';
export { posts } from './schema/posts';
export type { Session } from './schema/sessions';
export { sessions } from './schema/sessions';
export type { User } from './schema/users';
export { SUPPORTED_LOCALES, SUPPORTED_ZONES, users } from './schema/users';
