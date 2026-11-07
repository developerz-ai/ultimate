// Adapter parity for the passkey slice: the same questions asked of `MemoryAuthAdapter` (what
// `x new`, `x dev` and every test runs against) and of `PostgresAuthAdapter` (what production runs
// against), through one `describe.each` so neither side can move alone. The Postgres half runs on
// PGlite against the real `AUTH_TABLES` DDL, as `adapter-parity-mfa.test.ts` does — a recorded
// statement list would happily agree with a column that does not exist.
//
// The two places this domain diverges silently: the sign-count compare-and-set (a clone check that
// answers `true` in memory and `false` in Postgres lets a replayed assertion through under `x dev`
// only), and the evidence row's digest, which is the whole of what a step-up binds to.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { postgresAuthAdapter } from './builtin-adapter';
import { memoryAuthAdapter } from './memory-adapter';
import type { PasskeyAssertion, PasskeyCredential } from './passkey-store';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const client = pgliteClient();

const ADA = '00000000-0000-7000-8000-000000000401';
const GRACE = '00000000-0000-7000-8000-000000000402';
const AT = new Date('2026-11-05T09:00:00.000Z');
const EXPIRES = new Date('2026-11-05T09:05:00.000Z');

const CREDENTIAL = 'c2NyYXRjaC1jcmVkZW50aWFsLWlkLTAwMQ';
const CREDENTIAL_2 = 'c2NyYXRjaC1jcmVkZW50aWFsLWlkLTAwMg';

beforeAll(async () => {
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

/** Both tables carry a foreign key onto `x_users`, so every case needs the owner to exist first. */
const seeded = async (adapter: AuthAdapter): Promise<AuthAdapter> => {
  for (const [id, email] of [
    [ADA, 'ada@corp.test'],
    [GRACE, 'grace@corp.test'],
  ] as const) {
    await adapter.createUser({
      id,
      email,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: AT,
    });
  }
  return adapter;
};

const credential = (overrides: Partial<PasskeyCredential> = {}): PasskeyCredential => ({
  id: '00000000-0000-7000-8000-000000000501',
  userId: ADA,
  credentialId: CREDENTIAL,
  publicKeyCose: 'pQECAyYgASFYIB0-public-key',
  signCount: 0,
  transports: ['internal', 'hybrid'],
  createdAt: AT,
  lastUsedAt: null,
  ...overrides,
});

const assertion = (overrides: Partial<PasskeyAssertion> = {}): PasskeyAssertion => ({
  id: '00000000-0000-7000-8000-000000000601',
  userId: ADA,
  credentialId: CREDENTIAL,
  challenge: 'Y2hhbGxlbmdlLWJ5dGVz',
  requestDigest: 'digest-of-request-A',
  clientDataJson: '{"type":"webauthn.get"}',
  authenticatorData: 'YXV0aGVudGljYXRvci1kYXRh',
  signature: 'c2lnbmF0dXJl',
  verifiedAt: AT,
  expiresAt: EXPIRES,
  ...overrides,
});

/** The binding a step-up makes: the stored evidence names the digest of the request it authorised. */
const binds = (evidence: PasskeyAssertion | null, digest: string): boolean =>
  evidence !== null && evidence.requestDigest === digest;

const adapters: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAuthAdapter', () => seeded(memoryAuthAdapter())],
  [
    'PostgresAuthAdapter',
    async () => {
      // Both tables first (`x_passkeys` references `x_users`), then the users every case needs.
      await client.execute(raw('delete from x_passkey_assertions'));
      await client.execute(raw('delete from x_passkeys'));
      await client.execute(raw('delete from x_users'));
      return await seeded(postgresAuthAdapter(client));
    },
  ],
];

describe.each(adapters)('%s — a registered passkey', (_, build) => {
  test('round-trips every field, and an unknown handle answers null', async () => {
    const adapter = await build();
    await adapter.putPasskey(credential());

    expect(await adapter.findPasskeyByCredentialId(CREDENTIAL)).toEqual(credential());
    expect(await adapter.findPasskeyByCredentialId('never-registered')).toBeNull();
  });

  test('is listed for its own user only, newest first', async () => {
    const adapter = await build();
    await adapter.putPasskey(credential());
    await adapter.putPasskey(
      credential({
        id: '00000000-0000-7000-8000-000000000502',
        credentialId: CREDENTIAL_2,
        createdAt: new Date('2026-11-05T10:00:00.000Z'),
      }),
    );
    await adapter.putPasskey(
      credential({
        id: '00000000-0000-7000-8000-000000000503',
        userId: GRACE,
        // `credential_id` is unique across the table, not per user: reusing one here would upsert
        // Ada's row onto Grace rather than giving her a passkey of her own.
        credentialId: 'c2NyYXRjaC1jcmVkZW50aWFsLWlkLWdyYWNl',
      }),
    );

    const listed = await adapter.listPasskeys(ADA);
    expect(listed.map((record) => record.credentialId)).toEqual([CREDENTIAL_2, CREDENTIAL]);
    expect(await adapter.listPasskeys('00000000-0000-7000-8000-0000000004ff')).toEqual([]);
  });

  // `x_passkeys.credential_id` is unique ON ITS OWN: two rows claiming one handle would leave the
  // sign-in reading whichever came back first, which is verification against the wrong public key.
  test('re-registers onto the one row, and the record it answers is the row that is now stored', async () => {
    const adapter = await build();
    await adapter.putPasskey(credential());
    const again = credential({
      id: '00000000-0000-7000-8000-000000000504',
      publicKeyCose: 're-registered-key',
    });
    await adapter.putPasskey(again);

    expect((await adapter.listPasskeys(ADA)).length).toBe(1);
    expect(await adapter.findPasskeyByCredentialId(CREDENTIAL)).toEqual(again);
    // The id the caller was handed addresses the stored row — what `updatePasskeyUsage` takes.
    expect(await adapter.updatePasskeyUsage(again.id, 5, AT)).toBe(true);
  });
});

describe.each(adapters)('%s — the sign count moves forward or not at all', (_, build) => {
  test('a counter that does not advance is refused, and the stored one is unchanged', async () => {
    const adapter = await build();
    const record = credential({ signCount: 4 });
    await adapter.putPasskey(record);

    expect(await adapter.updatePasskeyUsage(record.id, 5, AT)).toBe(true);
    // The replay: the identical assertion presented a second time.
    expect(await adapter.updatePasskeyUsage(record.id, 5, AT)).toBe(false);
    // A counter below the stored one is a cloned authenticator.
    expect(await adapter.updatePasskeyUsage(record.id, 3, AT)).toBe(false);
    expect(await adapter.updatePasskeyUsage('00000000-0000-7000-8000-0000000005ff', 9, AT)).toBe(
      false,
    );

    const stored = await adapter.findPasskeyByCredentialId(CREDENTIAL);
    expect(stored?.signCount).toBe(5);
    expect(stored?.lastUsedAt).toEqual(AT);
  });

  test('ten concurrent assertions of one counter: exactly one wins', async () => {
    const adapter = await build();
    const record = credential({ signCount: 0 });
    await adapter.putPasskey(record);

    // A read-then-write would let every one of these read 0 and every one of them write. The
    // condition inside the UPDATE (and the memory compare-and-set) is what makes it one.
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => adapter.updatePasskeyUsage(record.id, 7, AT)),
    );
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect((await adapter.findPasskeyByCredentialId(CREDENTIAL))?.signCount).toBe(7);
  });
});

describe.each(adapters)('%s — the stored assertion is evidence', (_, build) => {
  test('reads back with its digest and expiry intact', async () => {
    const adapter = await build();
    await adapter.putPasskey(credential());
    await adapter.putPasskeyAssertion(assertion());

    const stored = await adapter.findPasskeyAssertion('00000000-0000-7000-8000-000000000601');
    expect(stored).toEqual(assertion());
    expect(stored?.expiresAt).toEqual(EXPIRES);
    expect(binds(stored, 'digest-of-request-A')).toBe(true);
    expect(await adapter.findPasskeyAssertion('never-written')).toBeNull();
  });

  test('a stored digest that differs from the request stops the step-up binding', async () => {
    const adapter = await build();
    const id = '00000000-0000-7000-8000-000000000601';
    await adapter.putPasskey(credential());
    await adapter.putPasskeyAssertion(assertion({ requestDigest: 'digest-of-request-A' }));
    expect(binds(await adapter.findPasskeyAssertion(id), 'digest-of-request-A')).toBe(true);

    // A step-up for a DIFFERENT request: the evidence proves one request, never a session.
    expect(binds(await adapter.findPasskeyAssertion(id), 'digest-of-request-B')).toBe(false);

    // Overwrite the row with the other digest and the binding flips. A reader that echoed its own
    // input rather than storage would still answer `true` for A here.
    await adapter.putPasskeyAssertion(assertion({ requestDigest: 'digest-of-request-B' }));
    expect(binds(await adapter.findPasskeyAssertion(id), 'digest-of-request-A')).toBe(false);
    expect(binds(await adapter.findPasskeyAssertion(id), 'digest-of-request-B')).toBe(true);
  });
});

describe('the evidence survives the writer, for a separate reader', () => {
  test('a second handle over the same database reads the digest and the expiry', async () => {
    await client.execute(raw('delete from x_passkey_assertions'));
    await client.execute(raw('delete from x_passkeys'));
    await client.execute(raw('delete from x_users'));
    const writer = await seeded(postgresAuthAdapter(client));
    await writer.putPasskey(credential());
    await writer.putPasskeyAssertion(assertion());

    // A distinct adapter — what a worker, an admin surface or a later request would hold — reads
    // the evidence the writer left, with no state carried over in memory.
    const reader = postgresAuthAdapter(client);
    const evidence = await reader.findPasskeyAssertion('00000000-0000-7000-8000-000000000601');
    expect(evidence?.requestDigest).toBe('digest-of-request-A');
    expect(evidence?.expiresAt).toEqual(EXPIRES);
    expect(binds(evidence, 'digest-of-request-A')).toBe(true);
    expect(binds(evidence, 'digest-of-request-B')).toBe(false);
  });
});
