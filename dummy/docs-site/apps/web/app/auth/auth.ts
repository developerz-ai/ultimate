// This app's one `@ultimat3/auth` instance: sessions, passwords and the lockout, over the
// framework's own `x_users` and `x_sessions` tables — `x dev` and `ROLE=migrate` apply them.
//
// Sign-in is one call once the app has a page for it: `login(appAuth(), { email, password, ip })`
// answers `{ token, cookie }` — set `cookie` on the response and every request after it is that
// user, through `authenticator.ts`. `register(appAuth(), { email, password, orgId, roles })`
// creates one.
import { type Auth, defineAuth, postgresAuthAdapter } from '@ultimat3/auth';

let built: Auth | undefined;

/**
 * Built on first use, never at import: the boot scan imports this module before the database and
 * the host's shared lockout limiter are installed, and `defineAuth` reads both.
 */
export const appAuth = (): Auth => {
  built ??= defineAuth({ adapter: postgresAuthAdapter() });
  return built;
};
