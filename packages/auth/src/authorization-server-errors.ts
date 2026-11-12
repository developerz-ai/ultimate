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

/** The lists of `RegisterClientInput` a value can be refused from. */
export type ClientListField = 'redirectUris' | 'grantTypes' | 'scopes' | 'resources';

/**
 * 422: `registerClient` was handed a value the store cannot hold as one value. The Postgres store
 * keeps each list as space-joined text, so whitespace inside a value reads back as two values, and
 * an empty one reads back as none — a redirect or a scope nobody registered.
 */
export const clientInvalid = (field: ClientListField, value: string): AuthError =>
  new AuthError({
    code: 'X_AUTH_CLIENT_INVALID',
    cause: `registerClient({ ${field} }) holds ${renderCauseValue(value)}, which is empty or has whitespace inside, and the store keeps each list as space-joined text, so it would read back as a different list`,
    fix: `server.registerClient({ name, ${field}: ['<one value per element, no whitespace>'] })   # split a space-separated string into its values before registering`,
    meta: { field },
  });
