// Single responsibility: `passkeyStepUp(auth, { digest })` — a fresh, user-verified assertion
// bound to bytes the SERVER computed from the action's input, so the stored assertion proves a
// person approved exactly those bytes. The WebAuthn challenge is derived (nonce + digest), never
// supplied: a caller cannot choose what is signed, only present what the server asked for.

import { timingSafeEqual, uuidV7 } from '@ultimat3/core';
import type { PasskeyEvidence } from './adapter';
import type { Auth } from './auth';
import { base64Url } from './base64url';
import { acceptAssertion } from './passkey-assertion';
import { issuePasskeyChallenge, redeemPasskeyChallenge } from './passkey-challenge';
import { passkeyPolicyOf } from './passkey-config';
import {
  MAX_STEP_UP_DIGEST_BYTES,
  passkeyStepUpRequired,
  refusePasskey,
  stepUpDigestInvalid,
} from './passkey-errors';
import { stepUpChallenge } from './passkey-evidence';
import { readEnvelope } from './passkey-verify';
import type { PasskeyRequestOptions } from './passkey-wire';
import { assertFiniteAuthCount } from './policy-numbers';
import { randomBytes } from './tokens';

export interface PasskeyStepUpOptions<I> {
  /**
   * The bytes the person approves, computed on the server from what the action will act on —
   * `({ input }) => sha256Hex(canonicalJson(input))`. Text is taken as UTF-8. 1 to 1024 bytes.
   */
  readonly digest: (args: {
    readonly input: I;
    readonly userId: string;
  }) => string | Uint8Array | Promise<string | Uint8Array>;
  /** How long a proof may wait for its action. Defaults to `passkeys.challengeTtlMs`. */
  readonly ttlMs?: number | undefined;
}

export interface PasskeyStepUp<I> {
  /** For the user about to act: hand the result to `getPasskey` in the browser. */
  options(args: { readonly userId: string; readonly input: I }): Promise<PasskeyRequestOptions>;
  /**
   * Inside the sensitive action, before it acts: the proof for THIS input, or
   * `X_PASSKEY_STEP_UP_REQUIRED`. The answer is stored and returned as evidence.
   */
  verify(args: {
    readonly userId: string;
    readonly input: I;
    readonly response: unknown;
  }): Promise<PasskeyEvidence>;
}

export function passkeyStepUp<I>(auth: Auth, declared: PasskeyStepUpOptions<I>): PasskeyStepUp<I> {
  const policy = passkeyPolicyOf(auth, 'passkeyStepUp');
  const ttlMs = assertFiniteAuthCount(
    'passkeyStepUp.ttlMs',
    declared.ttlMs ?? policy.challengeTtlMs,
    'a step-up proof would never expire',
    1,
  );
  const digestOf = async (input: I, userId: string): Promise<Uint8Array> => {
    const value = await declared.digest({ input, userId });
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (bytes.length === 0 || bytes.length > MAX_STEP_UP_DIGEST_BYTES) {
      throw stepUpDigestInvalid(bytes.length);
    }
    return bytes;
  };

  return {
    async options({ userId, input }) {
      const digest = await digestOf(input, userId);
      const passkeys = await auth.adapter.listPasskeys(userId);
      if (passkeys.length === 0) throw passkeyStepUpRequired('no-passkey');
      const nonce = randomBytes(32);
      const { challenge } = await issuePasskeyChallenge(auth, 'step-up', {
        userId,
        digest: base64Url(digest),
        nonce: base64Url(nonce),
        challenge: await stepUpChallenge(nonce, digest, userId),
        ttlMs,
      });
      return {
        challenge,
        rpId: policy.rpId,
        timeout: ttlMs,
        userVerification: 'required',
        allowCredentials: passkeys.map((row) => ({
          type: 'public-key' as const,
          id: row.id,
          transports: row.transports,
        })),
      };
    },

    async verify({ userId, input, response }) {
      if (response === undefined || response === null) throw passkeyStepUpRequired('no-proof');
      const envelope = readEnvelope(policy, response, 'webauthn.get');
      if (!envelope.ok) throw refusePasskey('step-up', envelope.check);
      const digest = base64Url(await digestOf(input, userId));
      const issued = await redeemPasskeyChallenge(auth, 'step-up', envelope.value.challenge);
      if (issued.userId !== userId) throw refusePasskey('step-up', 'user');
      // The proof is real and fresh, and for other bytes: the action this call carries was not
      // the one approved. A step-up for THIS input is still owed.
      if (
        issued.digest === null ||
        !timingSafeEqual(issued.digest, digest) ||
        issued.nonce === null
      ) {
        throw passkeyStepUpRequired('other-digest');
      }
      const { credential, assertion } = await acceptAssertion(
        auth,
        policy,
        'step-up',
        envelope.value,
        userId,
      );
      const evidence: PasskeyEvidence = {
        id: uuidV7(auth.clock),
        userId,
        credentialId: credential.id,
        digest,
        nonce: issued.nonce,
        authenticatorData: base64Url(assertion.authenticatorData),
        clientDataJSON: base64Url(envelope.value.clientDataJSON),
        signature: base64Url(assertion.signature),
        publicKey: credential.publicKey,
        algorithm: credential.algorithm,
        createdAt: auth.clock.now(),
      };
      await auth.adapter.putPasskeyEvidence(evidence);
      return evidence;
    },
  };
}
