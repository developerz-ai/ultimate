/**
 * Postly's `RuntimeOverrides`, read by `x dev` and `apps/web/server.ts` alike: the plain routes no
 * primitive projects to. Today that is the partner authorization server's RFC 6749 wire —
 * `/.well-known/oauth-authorization-server` and `POST /oauth/{token,revoke,introspect}`.
 */

import { partnerOAuth } from './app/partners/oauth';

export const runtime = { routes: partnerOAuth.routes };
