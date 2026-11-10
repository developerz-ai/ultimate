// A whole passkey sign-in and step-up on both adapters, the Postgres half on PGlite over
// `AUTH_TABLES`. The store's own contract — single-use challenges, ceremony scoping, the counter
// compare-and-set, owner-scoped deletes, the sweep — is `@ultimat3/testing`'s
// `authAdapterConformance`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { defineAuth } from './auth';
import { postgresAuthAdapter } from './builtin-adapter';
import { memoryAuthAdapter } from './memory-adapter';
import { passkeyLogin } from './passkey-login';
import { passkeyStepUp } from './passkey-step-up';
import { softAuthenticator } from './soft-authenticator';
import { AUTH_TABLES } from './tables';

const PGLITE_BOOT_MS = 30_000;
const NOW = new Date('2026-11-06T12:00:00.000Z');
const clock = frozenClock(NOW.getTime());
const client = pgliteClient();
const ADA = '00000000-0000-7000-8000-000000000b01';
const GRACE = '00000000-0000-7000-8000-000000000b02';

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

const ADAPTERS: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAuthAdapter', async () => memoryAuthAdapter(clock)],
  [
    'PostgresAuthAdapter on PGlite',
    async () => {
      for (const table of [
        'x_passkey_evidence',
        'x_passkey_challenges',
        'x_passkeys',
        'x_sessions',
        'x_users',
      ]) {
        await client.execute(raw(`delete from ${table}`));
      }
      return postgresAuthAdapter(client, clock);
    },
  ],
];

const seeded = async (make: () => Promise<AuthAdapter>): Promise<AuthAdapter> => {
  const adapter = await make();
  for (const [id, email] of [
    [ADA, 'ada@example.com'],
    [GRACE, 'grace@example.com'],
  ] as const) {
    await adapter.createUser({
      id,
      email,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
  }
  return adapter;
};

describe.each(ADAPTERS)('%s · PasskeyStore', (_name, make) => {
  test('a whole sign-in and a step-up run on this adapter', async () => {
    const adapter = await seeded(make);
    const auth = defineAuth({
      adapter,
      clock,
      passkeys: { rpId: 'localhost', origins: ['http://localhost:3000'] },
    });
    const passkeys = passkeyLogin(auth);
    const device = await softAuthenticator({ origin: 'http://localhost:3000' });
    await passkeys.register({
      userId: ADA,
      response: await device.create(await passkeys.registerOptions({ userId: ADA })),
    });
    const result = await passkeys.login({
      response: await device.get(await passkeys.loginOptions()),
    });
    expect(result.actor.id).toBe(ADA);
    const stepUp = passkeyStepUp<string>(auth, { digest: ({ input }) => input });
    const options = await stepUp.options({ userId: ADA, input: 'erase:grace' });
    const evidence = await stepUp.verify({
      userId: ADA,
      input: 'erase:grace',
      response: await device.get(options),
    });
    expect(await adapter.listPasskeyEvidence(evidence.digest)).toEqual([evidence]);
    expect((await adapter.findPasskey(device.credentialId))?.signCount).toBe(2);
  });
});
