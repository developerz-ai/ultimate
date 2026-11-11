// This app's one `@ultimat3/auth` instance: passwords, sessions and the lockout, over the
// framework's own `x_users` and `x_sessions` — signed in by HANDLE, the `@name` this app's URLs
// carry. `users` stays the app's table; an auth user carries the same id as its `users` row.

import { storesInPostgres } from '@social-media-clone/db';
import { type Auth, defineAuth, memoryAuthAdapter, postgresAuthAdapter } from '@ultimat3/auth';
import { MIN_PASSWORD_LENGTH } from '../../shared/auth-policy';
import { userIdByHandle } from './repo';
import { SESSION_TTL_MS } from './session-cookie';

let built: Auth | undefined;

/**
 * Built on first use, for `resetAppAuth` below: a test needs a fresh instance over a fresh memory
 * store, which an instance built at import could not give it. (Not for the boot order: since
 * 31.3.0 `defineAuth` reads the installed lockout limiter where it is used, and the Postgres
 * adapter reads `db()` per call.) The adapter follows the app's own store — Postgres when
 * `DATABASE_URL` is set, memory under `x dev` and in tests — so the users the seed writes and the
 * credentials auth reads live in the same place.
 *
 * One session clock, absolute: the idle window equals the absolute one, as the hand-rolled
 * sessions this replaced had no idle timeout.
 */
export const appAuth = (): Auth => {
  built ??= defineAuth({
    adapter: storesInPostgres(Bun.env) ? postgresAuthAdapter() : memoryAuthAdapter(),
    handles: userIdByHandle,
    password: { minLength: MIN_PASSWORD_LENGTH },
    session: { absoluteTtlMs: SESSION_TTL_MS, idleTtlMs: SESSION_TTL_MS },
  });
  return built;
};

/** Test seam: a fresh store needs a fresh instance; production builds one. */
export const resetAppAuth = (): void => {
  built = undefined;
};
