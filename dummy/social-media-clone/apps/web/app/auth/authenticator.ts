// The one edge between the session cookie and the framework. `viewerFor` did all the work and
// nothing called it outside its own test, so `hooks.authenticate` was absent and EVERY request
// was anonymous whatever cookie it carried — sign in succeeded, issued a session, and the very
// next page still refused you. A green `service.test.ts` proved the resolver correct the whole
// time; what it could not see was that no caller existed.

import { configureAuthenticator } from '@ultimat3/http';
import { readSessionToken } from '../../shared/session';
import { viewerFor } from './viewer';

/**
 * Registered at module scope: `loadApp` imports every module under `apps/*` before a listener
 * binds, and `dev-hooks.ts` reads the value back at server start — so importing this file IS the
 * wiring, in `x dev` and in the container alike.
 *
 * This is also the ONE place the relational graph is resolved. Everything downstream — a page, a
 * policy predicate, a live subscriber, an MCP tool — reads it off the actor this returns, and
 * nothing anywhere gets a second chance to ask the database who the viewer is.
 *
 * `new Date()` per request rather than a captured clock: session expiry is absolute, and a boot
 * that ran a week ago must not still be comparing against its own start time.
 */
configureAuthenticator((request) =>
  viewerFor(readSessionToken(request.header('cookie')), new Date()),
);
