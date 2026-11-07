/**
 * Postly's passkeys, declared once over its one `Auth`: sign-in (`passkeyLogin`) and the step-up an
 * owner gives before a member is erased (`passkeyStepUp`). The digest names the exact org and member,
 * so an approval for one erasure can never be spent on another. Everything cryptographic is the
 * framework's; the digest's wording is the one decision that is Postly's.
 */

import type { Auth, PasskeyLogin, PasskeyStepUp } from '@ultimat3/auth';
import { passkeyLogin, passkeyStepUp } from '@ultimat3/auth';
import { auth } from './login';

/** What an owner approves with their passkey: this member, of this org, forgotten. */
export interface ErasureRequest {
  readonly orgId: string;
  readonly memberId: string;
}

export interface PostlyPasskeys {
  readonly login: PasskeyLogin;
  readonly erasure: PasskeyStepUp<ErasureRequest>;
}

/** Two minutes: the approval sheet, then the confirm button. Versioned so the wording can change. */
export const postlyPasskeys = (from: Auth): PostlyPasskeys => ({
  login: passkeyLogin(from),
  erasure: passkeyStepUp<ErasureRequest>(from, {
    ttlMs: 120_000,
    digest: ({ input }) => `postly:erase-member:v1:${input.orgId}:${input.memberId}`,
  }),
});

export const passkeys = postlyPasskeys(auth);
