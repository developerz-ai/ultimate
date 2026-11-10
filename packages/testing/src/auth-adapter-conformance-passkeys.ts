// `PasskeyStore`, for `authAdapterConformance`: a credential id is globally unique, the counter
// advances by compare-and-set (two racing assertions must not both move it — the cloned-
// authenticator signal), a delete is the owner's, and a challenge is single-use for its ceremony.

import { expect } from 'bun:test';
import type { PasskeyChallengeRecord, PasskeyCredential, PasskeyEvidence } from '@ultimat3/auth';
import type { AuthAdapterCheck } from './auth-adapter-conformance-support';
import { idOf, refusal, seedUser } from './auth-adapter-conformance-support';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);
const ADVANCERS = 8;

const credential = (owner: string, signCount = 0, createdAt = NOW): PasskeyCredential => ({
  id: idOf('cred'),
  userId: owner,
  publicKey: 'pQECAyYgASFYIA',
  algorithm: -7,
  signCount,
  transports: ['internal'],
  createdAt,
  lastUsedAt: null,
});

const challenge = (expiresInMs: number, createdAt = NOW): PasskeyChallengeRecord => ({
  id: idOf('challenge'),
  ceremony: 'login',
  userId: null,
  digest: null,
  nonce: null,
  expiresAt: new Date(createdAt.getTime() + expiresInMs),
  createdAt,
});

const evidence = (owner: string, digest: string, createdAt: Date): PasskeyEvidence => ({
  id: idOf('evidence'),
  userId: owner,
  credentialId: idOf('cred'),
  digest,
  nonce: 'bm9uY2U',
  authenticatorData: 'YXV0aA',
  clientDataJSON: 'Y2xpZW50',
  signature: 'c2ln',
  publicKey: 'pQECAyYgASFYIA',
  algorithm: -7,
  createdAt,
});

export const AUTH_ADAPTER_PASSKEY_CHECKS: readonly AuthAdapterCheck[] = [
  {
    name: 'a passkey round-trips, lists oldest first, and a second at one id is refused',
    async run({ adapter }) {
      const [ada, grace] = [await seedUser(adapter), await seedUser(adapter)];
      const [older, newer] = [credential(ada), credential(ada, 0, later(1))];
      await adapter.putPasskey(newer);
      await adapter.putPasskey(older);
      expect((await adapter.listPasskeys(ada)).map((row) => row.id)).toEqual([older.id, newer.id]);
      expect(await adapter.findPasskey(older.id)).toEqual(older);
      expect(await refusal(adapter.putPasskey({ ...older, userId: grace }))).toStartWith(
        'X_AUTH_WRITE_FAILED',
      );
      expect((await adapter.findPasskey(older.id))?.userId).toBe(ada);
    },
  },
  {
    name: 'the counter advances only from the value it was read at, stamping its use',
    async run({ adapter }) {
      const row = credential(await seedUser(adapter), 4);
      await adapter.putPasskey(row);
      expect(await adapter.advancePasskeyCounter(row.id, 4, 5, later(5))).toBe(true);
      expect(await adapter.advancePasskeyCounter(row.id, 4, 6, later(6))).toBe(false);
      const stored = await adapter.findPasskey(row.id);
      expect([stored?.signCount, stored?.lastUsedAt?.getTime()]).toEqual([5, later(5).getTime()]);
    },
  },
  {
    name: `${ADVANCERS} racing advances from one counter value: exactly one lands`,
    async run({ adapter }) {
      const row = credential(await seedUser(adapter), 1);
      await adapter.putPasskey(row);
      const answers = await Promise.all(
        Array.from({ length: ADVANCERS }, (_, index) =>
          adapter.advancePasskeyCounter(row.id, 1, 2 + index, NOW),
        ),
      );
      expect(answers.filter(Boolean)).toHaveLength(1);
    },
  },
  {
    name: 'a passkey is deleted only by its owner',
    async run({ adapter }) {
      const [ada, grace] = [await seedUser(adapter), await seedUser(adapter)];
      const row = credential(ada);
      await adapter.putPasskey(row);
      expect(await adapter.deletePasskey(grace, row.id)).toBe(false);
      expect(await adapter.deletePasskey(ada, row.id)).toBe(true);
      expect(await adapter.findPasskey(row.id)).toBeNull();
    },
  },
  {
    name: 'a challenge is taken once, and only for its own ceremony',
    async run({ adapter }) {
      const row = challenge(60_000);
      await adapter.putPasskeyChallenge(row);
      expect(await adapter.takePasskeyChallenge(row.id, 'step-up')).toBeNull();
      expect((await adapter.takePasskeyChallenge(row.id, 'login'))?.id).toBe(row.id);
      expect(await adapter.takePasskeyChallenge(row.id, 'login')).toBeNull();
    },
  },
  {
    name: 'issuing a challenge sweeps the ones already expired and keeps the live ones',
    async run({ adapter }) {
      const [stale, live] = [challenge(1_000), challenge(600_000)];
      await adapter.putPasskeyChallenge(stale);
      await adapter.putPasskeyChallenge(live);
      await adapter.putPasskeyChallenge(challenge(60_000, later(5_000)));
      expect(await adapter.takePasskeyChallenge(stale.id, 'login')).toBeNull();
      expect((await adapter.takePasskeyChallenge(live.id, 'login'))?.id).toBe(live.id);
    },
  },
  {
    name: 'evidence lists every approval of one digest, oldest first, and no other digest',
    async run({ adapter }) {
      const owner = await seedUser(adapter);
      const digest = idOf('digest');
      const [first, second] = [evidence(owner, digest, NOW), evidence(owner, digest, later(1))];
      await adapter.putPasskeyEvidence(second);
      await adapter.putPasskeyEvidence(first);
      await adapter.putPasskeyEvidence(evidence(owner, idOf('other'), NOW));
      expect(await adapter.listPasskeyEvidence(digest)).toEqual([first, second]);
    },
  },
];
