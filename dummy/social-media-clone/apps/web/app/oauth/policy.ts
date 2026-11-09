// Authorization for the OAuth consent page and its two decisions. One permission, no predicate:
// the person decides for themselves, so "signed in and allowed to connect an agent" is the whole
// question — and a grant that can be withdrawn from consent alone keeps that a policy, not a flag.

import { can, definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'oauth:consent': true;
  }
}

export const oauthPermissions = definePermissions(['oauth:consent']);

/**
 * A PERSON's decision. An agent holds its person's role, so the grant alone would let an
 * OAuth-connected agent approve a second connection for itself; only a user actor may answer.
 */
export const oauthConsent = can('oauth:consent', ({ actor }) => actor?.kind === 'user');
