// Single responsibility: the two marks that let an invite's accept and revoke agree without a
// transaction — `joined` (this address joined this org THROUGH an invite, so revoke may remove it)
// and `revoked` (a revoke replaced the invite's row). Both ride the verification store, the one
// seam both calls share, through its two atomic operations: an upsert and a take-on-hash-match.

import type { Clock } from '@ultimat3/core';
import type { VerificationStore } from './adapter';
import { randomToken, sha256Hex } from './tokens';

export type InviteMark = 'joined' | 'revoked';

/**
 * Where a mark lives. `revoked` takes the invite's OWN row, so a re-invite (which upserts that row)
 * clears it; `joined` lives under its own purpose, so it outlives the spent link. Neither purpose
 * suffix is a registered purpose, so no `consume` can reach a `joined` row.
 */
const slot = (purpose: string, mark: InviteMark): string =>
  mark === 'revoked' ? purpose : `${purpose}:joined`;

/**
 * The mark's stored hash. Prefixed, so it is never a `sha256Hex` output and no token redeems it —
 * a deterministic hash in the invite's own row would otherwise be a link anyone could compute.
 */
const markHash = (mark: InviteMark, key: string): string => `${mark}:${sha256Hex(key)}`;

export async function putMark(
  store: VerificationStore,
  clock: Clock,
  purpose: string,
  mark: InviteMark,
  key: string,
): Promise<void> {
  const now = clock.now();
  await store.putVerification({
    id: randomToken(12),
    purpose: slot(purpose, mark),
    identifier: key,
    tokenHash: markHash(mark, key),
    // Never read as a lifetime: a mark is only ever taken, and `take` does not judge expiry.
    expiresAt: now,
    consumedAt: null,
    createdAt: now,
  });
}

/** Takes the mark if it is there, in the store's one atomic step. `true` when it was. */
export async function takeMark(
  store: VerificationStore,
  purpose: string,
  mark: InviteMark,
  key: string,
): Promise<boolean> {
  const taken = await store.takeVerification(slot(purpose, mark), key, markHash(mark, key));
  return taken !== null;
}
