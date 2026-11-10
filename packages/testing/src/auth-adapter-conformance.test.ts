// The conformance suite over the memory adapter and the Postgres adapter on PGlite (a real
// server's constraints and row locks, no service to start), and the proof it can fail: a lookup
// that folds case — the divergence that linked an OAuth login under `x dev` and created a second
// account in production — and a recovery code read and written in two steps.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@ultimat3/auth';
import { AUTH_TABLES, memoryAuthAdapter, postgresAuthAdapter } from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { pgliteClient, raw } from '@ultimat3/db';
import { AUTH_ADAPTER_CHECKS, authAdapterConformance } from './auth-adapter-conformance';
import type { AuthAdapterSubject } from './auth-adapter-conformance-support';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const PGLITE_BOOT_MS = 30_000;
const START = '2031-03-04T05:06:07.000Z';

const memory = (): AuthAdapterSubject => {
  const clock = frozenClock(START);
  return { adapter: memoryAuthAdapter(clock), clock };
};

describe(testName('unit', 'the memory auth adapter'), () => {
  behavesLike(authAdapterConformance, memory);
});

describe(testName('unit', 'the postgres auth adapter on PGlite'), () => {
  const client = pgliteClient();
  const clock = frozenClock(START);

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

  behavesLike(authAdapterConformance, () => ({
    adapter: postgresAuthAdapter(client, clock),
    clock,
  }));
});

/** The memory adapter with some members replaced — a class instance, so a Proxy, never a spread. */
const overriding = (build: (real: AuthAdapter) => Partial<AuthAdapter>): AuthAdapterSubject => {
  const { adapter, clock } = memory();
  const overrides: Partial<AuthAdapter> = build(adapter);
  const wrapped = new Proxy(adapter, {
    get(target, key) {
      const replaced: unknown = typeof key === 'string' ? Reflect.get(overrides, key) : undefined;
      if (replaced !== undefined) return replaced;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { adapter: wrapped, clock };
};

/** Tries the address as given, then lowercased: "yes, that account exists" where Postgres says no. */
const foldsCase = (): AuthAdapterSubject =>
  overriding((real) => ({
    findUserByEmail: async (email: string) =>
      (await real.findUserByEmail(email)) ?? (await real.findUserByEmail(email.toLowerCase())),
  }));

/** Reads the codes, yields, then writes: every concurrent redeemer finds the code. */
const checkThenConsume = (): AuthAdapterSubject =>
  overriding((real) => ({
    consumeRecoveryCode: async (userId: string, codeHash: string) => {
      const held = (await real.findUserById(userId))?.recoveryCodeHashes ?? [];
      if (!held.includes(codeHash)) return false;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await real.updateUser(userId, {
        recoveryCodeHashes: held.filter((hash) => hash !== codeHash),
      });
      return true;
    },
  }));

const check = (name: string) => {
  const found = AUTH_ADAPTER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'an adapter that breaks the contract fails conformance'), () => {
  test('a lookup that folds case', async () => {
    const lookup = check('an address is stored as handed');
    await expect(lookup.run(foldsCase())).rejects.toThrow();
    await lookup.run(memory());
  });

  test('a recovery code read, then written', async () => {
    const race = check('10 concurrent redemptions');
    await expect(race.run(checkThenConsume())).rejects.toThrow();
    await race.run(memory());
  });

  test('every check has a name of its own', () => {
    const names = AUTH_ADAPTER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
