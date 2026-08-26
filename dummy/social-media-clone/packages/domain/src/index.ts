// Pure types, constants and predicates. No I/O of any kind: no fs, no network, no database, no env,
// no clock. That property is what lets every other package — and one day a phone — depend on this
// one without dragging a runtime along.

export type { Handle, UserId } from './ids';
export {
  BLOCKED_BOTH_WAYS,
  HANDLE_RE,
  handle,
  isValidHandle,
  MAX_HANDLE,
  userId,
} from './ids';
export type { Audience, FriendshipStatus, MediaKind, MediaState, UserRole } from './social';
export {
  AUDIENCES,
  BODY_MAX,
  canModerate,
  FRIENDSHIP_STATUSES,
  hasRespondedCoherently,
  isVisibleAudience,
  MEDIA_KINDS,
  MEDIA_STATES,
  USER_ROLES,
} from './social';
