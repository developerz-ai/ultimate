// The conformance suite over the memory store, and the proof it can fail: a take that never marks
// the code used (every replay is fresh), and a revokeGrants that ignores the client it was handed.

import { describe, expect, test } from 'bun:test';
import { memoryAuthServerStore } from '@ultimat3/auth';
import type { AuthServerStore } from '@ultimat3/auth/adapter';
import {
  AUTH_SERVER_STORE_CHECKS,
  authServerStoreConformance,
} from './auth-server-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory authorization-server store'), () => {
  behavesLike(authServerStoreConformance, () => memoryAuthServerStore());
});

/** Answers the code as fresh every time: the read is there, the spend is not. */
const neverSpends = (): AuthServerStore => {
  const inner = memoryAuthServerStore();
  return {
    ...inner,
    takeCode: async (codeHash) => {
      const code = await inner.getCode(codeHash);
      return code === null ? null : { code, fresh: true };
    },
  };
};

/** "Sign out of this app" signs the person out of every app. */
const clientBlind = (): AuthServerStore => {
  const inner = memoryAuthServerStore();
  return { ...inner, revokeGrants: ({ subject }, at) => inner.revokeGrants({ subject }, at) };
};

const check = (name: string) => {
  const found = AUTH_SERVER_STORE_CHECKS.find((each) => each.name.includes(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a store that breaks the contract fails conformance'), () => {
  test('a take that never spends the code', async () => {
    const race = check('racing takes of one code');
    await expect(race.run(neverSpends())).rejects.toThrow();
    await expect(check('taken fresh once').run(neverSpends())).rejects.toThrow();
    await race.run(memoryAuthServerStore());
  });

  test('a revokeGrants that ignores the client', async () => {
    const revoke = check('revokes by id and by subject');
    await expect(revoke.run(clientBlind())).rejects.toThrow();
    await revoke.run(memoryAuthServerStore());
  });

  test('every check has a name of its own', () => {
    const names = AUTH_SERVER_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
