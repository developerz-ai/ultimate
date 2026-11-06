// What this app declares about HTTP. Module scope IS the wiring: the boot scan imports every
// module under `apps/*` before a listener binds, and `x dev` and the container both read the
// configured value back at start — the same seam `app/auth/authenticator.ts` installs through.
//
// The BOOT lays its own facts over whatever this says: `port`, `hostname`, `dev`, `buildId`,
// `signInPath`, `trustProxy`, `trustedProxyHops` and `rateLimit.scope` are all facts about the
// PROCESS, so writing one here is a type error rather than a value silently overwritten at the
// next boot.

import { configureHttp } from '@ultimat3/http';

configureHttp({
  // EMPTY by default, and that is a refusal rather than an oversight: an origin list is a list of
  // sites allowed to make credentialed calls with this app's cookies, and a framework may not
  // guess one. A browser app served from another origin — a Vite dev server, a separate marketing
  // site — goes here, exactly spelled, scheme and port included:
  //
  //   cors: { origins: ['http://localhost:5173'] },
  //
  // `credentials` is `true` by default, and `'*'` with credentials is the one combination a
  // browser refuses — `@ultimat3/http` refuses it here instead, at the moment you can act on it.
  cors: { origins: [] },
  // The two bounds a request is measured against. Both are the framework's defaults spelled out,
  // so raising one for an endpoint that really does take a 4 MB CSV or five minutes is an edit to
  // a number that is already in front of you rather than a search for the knob.
  bodyLimitBytes: 1024 * 1024,
  requestTimeoutMs: 30_000,
});

/** Named so the module has an export; importing it for the side effect alone is the wiring. */
export const docsSiteHttp = 'configured';
