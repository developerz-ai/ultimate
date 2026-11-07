// Single responsibility: accepting an assertion against a STORED credential — owner, signature,
// user handle, and the signature counter's non-regression, advanced compare-and-set. Shared by
// sign-in and step-up, so the two can never disagree about what a valid assertion is.

import { logger } from '@ultimat3/core';
import type { PasskeyCredential } from './adapter';
import type { Auth } from './auth';
import type { PasskeyRelyingParty } from './passkey-config';
import { refusePasskey } from './passkey-errors';
import { type CeremonyEnvelope, type VerifiedAssertion, verifyAssertion } from './passkey-verify';

export interface AcceptedAssertion {
  readonly credential: PasskeyCredential;
  readonly assertion: VerifiedAssertion;
}

/**
 * `expectedUserId` is the account the ceremony was issued to (step-up), or `null` when the
 * credential names its own (usernameless sign-in) — then the returned `userHandle`, when the
 * authenticator sent one, must agree with the stored owner.
 */
export async function acceptAssertion(
  auth: Auth,
  policy: PasskeyRelyingParty,
  ceremony: 'login' | 'step-up',
  envelope: CeremonyEnvelope,
  expectedUserId: string | null,
): Promise<AcceptedAssertion> {
  const credential = await auth.adapter.findPasskey(envelope.credentialId);
  if (credential === null) throw refusePasskey(ceremony, 'credential-unknown');
  if (expectedUserId !== null && credential.userId !== expectedUserId) {
    throw refusePasskey(ceremony, 'credential-owner');
  }
  const verified = await verifyAssertion(policy, envelope, credential.publicKey);
  if (!verified.ok) throw refusePasskey(ceremony, verified.check);
  const assertion = verified.value;
  if (assertion.userHandle !== null && assertion.userHandle !== credential.userId) {
    throw refusePasskey(ceremony, 'user-handle');
  }
  // §7.2 step 21: a counter that did not move forward means two devices hold this key. Both
  // zero is an authenticator that keeps no counter (most synced passkeys), which is allowed.
  const counted = assertion.signCount !== 0 || credential.signCount !== 0;
  if (counted && assertion.signCount <= credential.signCount) {
    logger.warn('auth.passkey.counter_regressed', {
      credentialId: credential.id,
      stored: credential.signCount,
      presented: assertion.signCount,
    });
    throw refusePasskey(ceremony, 'counter');
  }
  const advanced = await auth.adapter.advancePasskeyCounter(
    credential.id,
    credential.signCount,
    assertion.signCount,
    auth.clock.now(),
  );
  // Lost the compare-and-set: another assertion on this counter value landed first.
  if (!advanced) throw refusePasskey(ceremony, 'counter-race');
  return { credential, assertion };
}
