// Single responsibility: `MemoryAuthAdapter`'s `PasskeyStore` members — the three `x_passkey*`
// tables as maps, with the same constraints Postgres enforces (a credential id is unique across
// every user; a take deletes) so a flow that passes here passes there. `passkey-store.test.ts`.

import { timingSafeEqual } from '@ultimat3/core';
import type {
  PasskeyChallengeRecord,
  PasskeyCredential,
  PasskeyEvidence,
  PasskeyStore,
} from './adapter';
import { authUniqueViolation } from './errors';

const byCreated = <T extends { readonly createdAt: Date; readonly id: string }>(a: T, b: T) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The members over three maps, as closures — `MemoryAuthAdapter` binds each one as a field. */
export function memoryPasskeyStore(): PasskeyStore {
  const passkeys = new Map<string, PasskeyCredential>();
  const challenges = new Map<string, PasskeyChallengeRecord>();
  const evidence = new Map<string, PasskeyEvidence>();
  return {
    async putPasskey(credential) {
      if (passkeys.has(credential.id)) throw authUniqueViolation('putPasskey', 'x_passkeys', 'id');
      const stored = { ...credential, transports: [...credential.transports] };
      passkeys.set(credential.id, stored);
      return stored;
    },
    async findPasskey(id) {
      return passkeys.get(id) ?? null;
    },
    async listPasskeys(userId) {
      return [...passkeys.values()].filter((row) => row.userId === userId).sort(byCreated);
    },
    async advancePasskeyCounter(id, expected, next, at) {
      const row = passkeys.get(id);
      if (row === undefined || row.signCount !== expected) return false;
      passkeys.set(id, { ...row, signCount: next, lastUsedAt: at });
      return true;
    },
    async deletePasskey(userId, id) {
      if (passkeys.get(id)?.userId !== userId) return false;
      return passkeys.delete(id);
    },
    async putPasskeyChallenge(record) {
      // Swept from the oldest put, stopping at the first live one: insertion order is issue order,
      // so a put costs the expired rows it removes plus one. A full scan per put made a flood of
      // unauthenticated `loginOptions` within one TTL quadratic. A live row never goes early; an
      // expired one behind a longer-lived row waits for it, which bounds memory by the longest TTL.
      const nowMs = record.createdAt.getTime();
      for (const [id, row] of challenges) {
        if (row.expiresAt.getTime() >= nowMs) break;
        challenges.delete(id);
      }
      // Deleted first, so a re-put of one id moves to the end with its new expiry.
      challenges.delete(record.id);
      challenges.set(record.id, record);
    },
    async takePasskeyChallenge(id, ceremony) {
      const row = challenges.get(id);
      if (row === undefined || row.ceremony !== ceremony) return null;
      challenges.delete(id);
      return row;
    },
    async putPasskeyEvidence(record) {
      if (evidence.has(record.id)) {
        throw authUniqueViolation('putPasskeyEvidence', 'x_passkey_evidence', 'id');
      }
      evidence.set(record.id, record);
    },
    async listPasskeyEvidence(digest) {
      return [...evidence.values()]
        .filter((row) => timingSafeEqual(row.digest, digest))
        .sort(byCreated);
    },
  };
}
