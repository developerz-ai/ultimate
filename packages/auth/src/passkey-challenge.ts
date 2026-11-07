// Single responsibility: a ceremony challenge's life — minted from the CSPRNG (or, for a step-up,
// derived from a nonce and the server's digest), stored as its sha256 with a TTL through the
// adapter, and redeemed ONCE by the hash `clientDataJSON` echoes. Never a process-local map: a
// fleet answers the options on one replica and the response on another.

import type { PasskeyCeremony, PasskeyChallengeRecord } from './adapter';
import type { Auth } from './auth';
import { base64Url } from './base64url';
import { passkeyChallengeExpired } from './passkey-errors';
import { randomBytes, sha256Hex } from './tokens';

export interface IssuedChallenge {
  /** The base64url challenge to put in the options. */
  readonly challenge: string;
}

export interface ChallengeBinding {
  readonly userId: string | null;
  readonly digest?: string | undefined;
  readonly nonce?: string | undefined;
  /** A step-up's derived challenge; omitted, 32 random bytes are drawn. */
  readonly challenge?: Uint8Array | undefined;
  readonly ttlMs: number;
}

export async function issuePasskeyChallenge(
  auth: Auth,
  ceremony: PasskeyCeremony,
  binding: ChallengeBinding,
): Promise<IssuedChallenge> {
  const challenge = base64Url(binding.challenge ?? randomBytes(32));
  const now = auth.clock.now();
  await auth.adapter.putPasskeyChallenge({
    id: sha256Hex(challenge),
    ceremony,
    userId: binding.userId,
    digest: binding.digest ?? null,
    nonce: binding.nonce ?? null,
    expiresAt: new Date(now.getTime() + binding.ttlMs),
    createdAt: now,
  });
  return { challenge };
}

/**
 * Consumed first, judged second: an expired row is gone either way, and a replay of a redeemed
 * one finds nothing. Unknown, spent and late are ONE refusal — which it was is not the caller's.
 */
export async function redeemPasskeyChallenge(
  auth: Auth,
  ceremony: PasskeyCeremony,
  challenge: string,
): Promise<PasskeyChallengeRecord> {
  const row = await auth.adapter.takePasskeyChallenge(sha256Hex(challenge), ceremony);
  if (row === null || row.expiresAt.getTime() <= auth.clock.now().getTime()) {
    throw passkeyChallengeExpired(ceremony);
  }
  return row;
}
