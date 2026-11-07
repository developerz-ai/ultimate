// Single responsibility: what a step-up proof IS, checkable by anyone holding the row — the
// challenge derivation (`stepUpChallenge`) and `verifyPasskeyEvidence`, which re-runs every
// signature check offline: no adapter, no clock, no session. An auditor's process, a week later,
// needs the evidence row and the relying party, nothing else.

import { timingSafeEqual } from '@ultimat3/core';
import type { PasskeyEvidence } from './adapter';
import { base64Url, canonicalBase64UrlBytes } from './base64url';
import type { PasskeyRelyingParty } from './passkey-config';
import { readEnvelope, verifyAssertion } from './passkey-verify';

/** Versioned domain tag: a step-up challenge can never collide with a sign-in one's random bytes. */
const STEP_UP_TAG = new TextEncoder().encode('ultimate.passkey.step-up.v1\u0000');

/**
 * `SHA-256(tag || nonce || u16(len digest) || digest || userId)`. The nonce is a fixed 32 bytes
 * and the digest is length-prefixed, so no two inputs share an encoding. The nonce makes two
 * approvals of one digest two signatures; the user id makes the row's `userId` part of what was
 * signed, so re-attributing an approval to someone else breaks it.
 */
export async function stepUpChallenge(
  nonce: Uint8Array,
  digest: Uint8Array,
  userId: string,
): Promise<Uint8Array> {
  const user = new TextEncoder().encode(userId);
  const input = new Uint8Array(STEP_UP_TAG.length + nonce.length + 2 + digest.length + user.length);
  let at = 0;
  for (const part of [
    STEP_UP_TAG,
    nonce,
    Uint8Array.of(digest.length >> 8, digest.length & 0xff),
    digest,
    user,
  ]) {
    input.set(part, at);
    at += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/**
 * `true` only when the stored assertion is a user-verified signature, by the stored key, over a
 * challenge derived from the stored nonce, digest and user, made for this relying party. An edit
 * to any of those, to the key or to the signed bytes is `false`. What it cannot prove alone is
 * that the key is the user's: that is `x_passkeys`' row, and the reason the key is stored here.
 */
export async function verifyPasskeyEvidence(
  evidence: PasskeyEvidence,
  relyingParty: PasskeyRelyingParty,
): Promise<boolean> {
  const nonce = canonicalBase64UrlBytes(evidence.nonce);
  const digest = canonicalBase64UrlBytes(evidence.digest);
  if (nonce === null || nonce.length !== 32 || digest === null || digest.length === 0) return false;
  const envelope = readEnvelope(
    relyingParty,
    {
      id: evidence.credentialId,
      rawId: evidence.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: evidence.clientDataJSON,
        authenticatorData: evidence.authenticatorData,
        signature: evidence.signature,
      },
    },
    'webauthn.get',
  );
  if (!envelope.ok) return false;
  const expected = base64Url(await stepUpChallenge(nonce, digest, evidence.userId));
  if (!timingSafeEqual(envelope.value.challenge, expected)) return false;
  const verified = await verifyAssertion(relyingParty, envelope.value, evidence.publicKey);
  return verified.ok;
}
