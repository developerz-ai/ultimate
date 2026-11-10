// `VerificationStore`, `AccountStore` and `ApiKeyStore`, for `authAdapterConformance`: a token is
// consumed only on a hash match, in one step, stamped from the adapter's clock; a relinked
// provider account keeps its owner; api keys list newest first and revoke once.

import { expect } from 'bun:test';
import type { AuthAccount, AuthApiKeyRecord, AuthVerification } from '@ultimat3/auth';
import type { AuthAdapterCheck } from './auth-adapter-conformance-support';
import { emailOf, idOf, seedUser } from './auth-adapter-conformance-support';

const verification = (identifier: string, issuedAt: Date, tokenHash: string): AuthVerification => ({
  id: idOf('verification'),
  purpose: 'password-reset',
  identifier,
  tokenHash,
  expiresAt: new Date(issuedAt.getTime() + 3_600_000),
  consumedAt: null,
  createdAt: issuedAt,
});

const apiKey = (id: string, owner: string, createdAt: string): AuthApiKeyRecord => ({
  id,
  prefix: `ult_dev_${id}`,
  keyHash: 'hash',
  userId: owner,
  orgId: null,
  scopes: [],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date(createdAt),
});

export const AUTH_ADAPTER_CREDENTIAL_CHECKS: readonly AuthAdapterCheck[] = [
  {
    name: 'a verification is consumed once, on a hash match only, stamped from the adapter’s clock',
    async run({ adapter, clock }) {
      const identifier = emailOf('reset');
      // Issued an hour ago: the redemption stamp must be NOW, never the issue time.
      const issuedAt = new Date(clock.now().getTime() - 3_600_000);
      await adapter.putVerification(verification(identifier, issuedAt, 'digest'));
      expect(await adapter.takeVerification('password-reset', identifier, 'wrong')).toBeNull();
      const taken = await adapter.takeVerification('password-reset', identifier, 'digest');
      expect([taken?.consumedAt?.getTime(), taken?.createdAt.getTime()]).toEqual([
        clock.now().getTime(),
        issuedAt.getTime(),
      ]);
      expect(await adapter.takeVerification('password-reset', identifier, 'digest')).toBeNull();
    },
  },
  {
    name: 'issuing a new token for one purpose and address invalidates the previous one',
    async run({ adapter, clock }) {
      const identifier = emailOf('reissue');
      await adapter.putVerification(verification(identifier, clock.now(), 'first'));
      await adapter.putVerification(verification(identifier, clock.now(), 'second'));
      expect(await adapter.takeVerification('password-reset', identifier, 'first')).toBeNull();
      expect(
        (await adapter.takeVerification('password-reset', identifier, 'second'))?.tokenHash,
      ).toBe('second');
    },
  },
  {
    name: 'relinking a linked provider account keeps its owner, id and age, and moves the tokens',
    async run({ adapter }) {
      const [owner, taker] = [await seedUser(adapter), await seedUser(adapter)];
      const providerAccountId = idOf('gh');
      const first: AuthAccount = {
        id: crypto.randomUUID(),
        userId: owner,
        provider: 'github',
        providerAccountId,
        accessToken: 'gho_first',
        refreshToken: null,
        expiresAt: null,
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
      };
      await adapter.linkAccount(first);
      const answered = await adapter.linkAccount({
        ...first,
        id: crypto.randomUUID(),
        userId: taker,
        accessToken: 'gho_second',
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
      });
      const stored = await adapter.findAccount('github', providerAccountId);
      for (const account of [answered, stored]) {
        expect([account?.id, account?.userId, account?.createdAt.getTime()]).toEqual([
          first.id,
          owner,
          first.createdAt.getTime(),
        ]);
        expect(account?.accessToken).toBe('gho_second');
      }
      expect((await adapter.listAccounts(owner)).map((row) => row.id)).toEqual([first.id]);
      expect(await adapter.listAccounts(taker)).toEqual([]);
    },
  },
  {
    name: 'listApiKeys answers newest first, then by id descending',
    async run({ adapter }) {
      const owner = crypto.randomUUID();
      const [a1, b2, c3] = [idOf('a1'), idOf('b2'), idOf('c3')];
      await adapter.putApiKey(apiKey(a1, owner, '2026-08-01T00:00:00.000Z'));
      await adapter.putApiKey(apiKey(c3, owner, '2026-09-01T00:00:00.000Z'));
      await adapter.putApiKey(apiKey(b2, owner, '2026-09-01T00:00:00.000Z'));
      // `conformance-c3-…` sorts after `conformance-b2-…`: the tie on created_at is broken by id.
      expect((await adapter.listApiKeys(owner)).map((key) => key.id)).toEqual([c3, b2, a1]);
    },
  },
  {
    name: 'an api key is found, touched, and revoked exactly once',
    async run({ adapter, clock }) {
      const id = idOf('key');
      await adapter.putApiKey(apiKey(id, crypto.randomUUID(), '2026-08-01T00:00:00.000Z'));
      await adapter.touchApiKey(id, clock.now());
      expect((await adapter.findApiKeyById(id))?.lastUsedAt?.getTime()).toBe(clock.now().getTime());
      expect(await adapter.revokeApiKey(id, clock.now())).toBe(true);
      expect(await adapter.revokeApiKey(id, clock.now())).toBe(false);
      expect((await adapter.findApiKeyById(id))?.revokedAt?.getTime()).toBe(clock.now().getTime());
      expect(await adapter.findApiKeyById(idOf('nobody'))).toBeNull();
      expect(await adapter.revokeApiKey(idOf('nobody'), clock.now())).toBe(false);
    },
  },
];
