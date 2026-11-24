// A passkey a person can tell apart from their others: `renamePasskey(auth, { userId, id, label })`
// names it — right after `register`, or any time later — the owner's only, `null` clearing it.
// Both adapters, the Postgres half on PGlite over `AUTH_TABLES` (the label column included).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import type { AuthAdapter } from './adapter';
import { defineAuth } from './auth';
import { postgresAuthAdapter } from './builtin-adapter';
import { memoryAuthAdapter } from './memory-adapter';
import { renamePasskey } from './passkey-label';
import { passkeyLogin } from './passkey-login';
import { softAuthenticator } from './soft-authenticator';
import { AUTH_TABLES } from './tables';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const clock = frozenClock(NOW.getTime());
const client = pgliteClient();
const ADA = '00000000-0000-7000-8000-000000000c01';
const GRACE = '00000000-0000-7000-8000-000000000c02';
const ORIGIN = 'http://localhost:3000';

beforeAll(async () => {
  for (const entry of AUTH_TABLES) {
    for (const statement of entry.split(';')) {
      if (statement.trim() !== '') await client.execute(raw(statement));
    }
  }
}, 30_000);

afterAll(async () => {
  await client.close();
});

const ADAPTERS: readonly (readonly [string, () => Promise<AuthAdapter>])[] = [
  ['MemoryAuthAdapter', async () => memoryAuthAdapter(clock)],
  [
    'PostgresAuthAdapter on PGlite',
    async () => {
      for (const table of ['x_passkey_challenges', 'x_passkeys', 'x_users']) {
        await client.execute(raw(`delete from ${table}`));
      }
      return postgresAuthAdapter(client, clock);
    },
  ],
];

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not coded: ${String(error)}`;
  }
  return 'no refusal';
};

/** Ada with one passkey registered under `label`; Grace with none. */
const world = async (make: () => Promise<AuthAdapter>, label?: string | null) => {
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
  const auth = defineAuth({ adapter, clock, passkeys: { rpId: 'localhost', origins: [ORIGIN] } });
  const passkeys = passkeyLogin(auth);
  const device = await softAuthenticator({ origin: ORIGIN });
  const response = await device.create(await passkeys.registerOptions({ userId: ADA }));
  const registered = await passkeys.register({ userId: ADA, response });
  const stored =
    label === undefined
      ? registered
      : ((await renamePasskey(auth, { userId: ADA, id: registered.id, label })) ?? registered);
  return { adapter, auth, stored };
};

describe.each(ADAPTERS)('%s · a passkey label', (_name, make) => {
  test('a rename right after register stores a trimmed label, and the list reads it back', async () => {
    const { adapter, stored } = await world(make, '  Work laptop ');
    expect(stored.label).toBe('Work laptop');
    expect((await adapter.listPasskeys(ADA)).map((row) => row.label)).toEqual(['Work laptop']);
  });

  test('no label is no label', async () => {
    const { adapter, stored } = await world(make);
    expect(stored.label ?? null).toBeNull();
    expect((await adapter.findPasskey(stored.id))?.label ?? null).toBeNull();
  });

  test("rename is the owner's: another user's id answers null and changes nothing", async () => {
    const { adapter, auth, stored } = await world(make, 'Phone');
    // A use first, so a rename that reset the counter or the last use would show.
    expect(await adapter.advancePasskeyCounter(stored.id, stored.signCount, 7, NOW)).toBe(true);
    expect(await renamePasskey(auth, { userId: GRACE, id: stored.id, label: 'Mine' })).toBeNull();
    expect((await adapter.findPasskey(stored.id))?.label).toBe('Phone');
    const renamed = await renamePasskey(auth, { userId: ADA, id: stored.id, label: 'Old phone' });
    const cleared = await renamePasskey(auth, { userId: ADA, id: stored.id, label: null });
    const reloaded = await adapter.findPasskey(stored.id);
    expect(renamed?.label).toBe('Old phone');
    expect(cleared?.label ?? null).toBeNull();
    for (const row of [renamed, cleared, reloaded]) {
      expect([row?.signCount, row?.lastUsedAt?.getTime()]).toEqual([7, NOW.getTime()]);
    }
    expect(reloaded?.label ?? null).toBeNull();
  });

  test('a label handed to putPasskey is stored trimmed, as a rename stores it', async () => {
    const { adapter, stored } = await world(make);
    const id = `${stored.id}-second`;
    await adapter.putPasskey({ ...stored, id, label: '  Work laptop  ' });
    expect((await adapter.findPasskey(id))?.label).toBe('Work laptop');
  });

  test.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(65)],
    ['a control character', 'Work\nlaptop'],
    ['a lone surrogate', 'Work \uD800 laptop'],
  ])('a %s label is refused, and the stored one kept', async (_label, bad) => {
    const { adapter, auth, stored } = await world(make, 'Phone');
    expect(
      await codeOf(() => renamePasskey(auth, { userId: ADA, id: stored.id, label: bad })),
    ).toBe('X_PASSKEY_LABEL_INVALID');
    expect((await adapter.findPasskey(stored.id))?.label).toBe('Phone');
  });
});

test('an adapter with no renamePasskey is refused by name, not by a TypeError', async () => {
  const base = memoryAuthAdapter(clock);
  const adapter: AuthAdapter = Object.assign(Object.create(base) as AuthAdapter, {
    renamePasskey: undefined,
  });
  const auth = defineAuth({ adapter, clock, passkeys: { rpId: 'localhost', origins: [ORIGIN] } });
  expect(await codeOf(() => renamePasskey(auth, { userId: ADA, id: 'x', label: 'y' }))).toBe(
    'X_PASSKEY_RENAME_UNSUPPORTED',
  );
});

test('a table made before labels gains the column at boot, its passkeys kept and renamable', async () => {
  const old = pgliteClient();
  try {
    // `AUTH_TABLES` as it stood before the label: the create without the column.
    for (const entry of AUTH_TABLES) {
      const before = entry.replace(/,\s*label\s+text\s*\n\)/, '\n)');
      for (const statement of before.split(';')) {
        if (statement.trim() === '' || statement.includes('add column if not exists label'))
          continue;
        await old.execute(raw(statement));
      }
    }
    const columns = await old.query<{ column_name: string }>(
      raw("select column_name from information_schema.columns where table_name = 'x_passkeys'"),
    );
    expect(columns.map((row) => row.column_name)).not.toContain('label');
    const adapter = postgresAuthAdapter(old, clock);
    await adapter.createUser({
      id: ADA,
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
    await old.execute(
      raw(
        `insert into x_passkeys (id, user_id, public_key, algorithm) values ('cred-old', '${ADA}', 'pk', -7)`,
      ),
    );
    // The boot: every statement again, the upgrade included.
    for (const entry of AUTH_TABLES) {
      for (const statement of entry.split(';')) {
        if (statement.trim() !== '') await old.execute(raw(statement));
      }
    }
    const auth = defineAuth({ adapter, clock, passkeys: { rpId: 'localhost', origins: [ORIGIN] } });
    const renamed = await renamePasskey(auth, { userId: ADA, id: 'cred-old', label: 'Laptop' });
    expect([renamed?.id, renamed?.label, renamed?.publicKey]).toEqual(['cred-old', 'Laptop', 'pk']);
  } finally {
    await old.close();
  }
}, 30_000);
