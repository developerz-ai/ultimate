// Single responsibility: the authorization server's coded refusals — the ones an APP's code meets
// (a consent approved for a request the server refuses, a grant it never enabled). What a remote
// client meets is RFC 6749 JSON on the wire (`authorization-server-wire.ts`), never an `X_` code.

import { renderCauseValue } from '@ultimat3/core';
import { AuthError } from './errors';

/** 422: the consent page approved what `readRequest` would have refused to show. */
export const consentInvalid = (reason: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_CONSENT_INVALID',
    cause: `the consent was refused: ${reason}`,
    fix: 'server.readRequest(url)   # on the consent page: render its refusal when it has one, and approve only the request it returned',
    callerFix: 'start the sign-in again from the application that sent you here',
  });

/** Logged, never thrown at a client: the wire answers `unsupported_grant_type`. */
export const grantDisabled = (grantType: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_GRANT_DISABLED',
    cause: `a client asked for grant_type ${renderCauseValue(grantType)}, which authorizationServer({ grants }) does not enable`,
    fix: "authorizationServer({ grants: ['authorization_code', 'refresh_token', '<grant>'] })   # with its lifetime — or the client uses an enabled grant",
  });
