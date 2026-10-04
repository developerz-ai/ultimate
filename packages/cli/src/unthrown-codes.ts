// The registered codes this repo no longer throws, as a list `error-unthrown.ts` reads — its own
// file, so the literals naming the waived codes are not mistaken for a throw site.

/** Where the list lives, so a finding can name the file to edit. */
export const UNTHROWN_CODES_FILE = 'packages/cli/src/unthrown-codes.ts';

/**
 * The codes this repo registers and no longer throws — each a decision, and each row on the
 * reference page says so in words. A LIST, never a prose match: the waiver was any row containing
 * "not thrown" or "thrown by nothing", so a sentence that happened to use either phrase silenced the
 * rule for its code. A listing whose code is thrown again, or is not registered, is
 * `X_ERROR_CODE_UNTHROWN_STALE`.
 */
export const UNTHROWN_CODES: ReadonlySet<string> = new Set([
  // `x db studio` is planned and unreleased; it exits X_NOT_IMPLEMENTED.
  'X_DB_STUDIO_FAILED',
  // 21.0.0: there is no LiveClient to register (X_REALTIME_UNINSTALLED replaced it).
  'X_LIVE_CLIENT_MISSING',
  // 21.0.0: liveHookFor was deleted; useQuery reads any query.
  'X_QUERY_NOT_SUBSCRIBABLE',
  // 21.0.0: the worker no longer POSTs a flush endpoint nothing mounted.
  'X_PWA_SYNC_FLUSH_FAILED',
  'X_PWA_SYNC_INCOMPLETE',
  // 24.0.0: `x test --worker` was deleted; `x verify --only unit --shard i/n` is the one split.
  'X_TEST_SHARD_FAILED',
]);
