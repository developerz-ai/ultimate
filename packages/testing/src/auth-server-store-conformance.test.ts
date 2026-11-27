// The conformance suite over the memory store, and the proof it can fail: a take that never marks
// the code used (every replay is fresh), a revokeGrants that ignores the client it was handed, and
// a revokeLiveGrant that claims a second revoke of one grant ended it too.

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

  test('a revokeLiveGrant that claims every call ended the grant', async () => {
    const inner = memoryAuthServerStore();
    const alwaysEnds: AuthServerStore = {
      ...inner,
      revokeLiveGrant: async (id, at) => {
        await inner.revokeGrant(id, at);
        return true;
      },
    };
    const answers = check('revokeLiveGrant answers true only');
    await expect(answers.run(alwaysEnds)).rejects.toThrow();
    await answers.run(memoryAuthServerStore());
  });

  test('a revokeLiveGrant that ends every grant of the subject', async () => {
    const inner = memoryAuthServerStore();
    const subjectWide: AuthServerStore = {
      ...inner,
      // Atomic on the asked grant, so only the sibling assertion can catch it.
      revokeLiveGrant: async (id, at) => {
        const won = (await inner.revokeLiveGrant?.(id, at)) === true;
        const grant = await inner.getGrant(id);
        if (won && grant !== null) await inner.revokeGrants({ subject: grant.subject }, at);
        return won;
      },
    };
    await expect(check('revokeLiveGrant answers true only').run(subjectWide)).rejects.toThrow();
  });

  test('a revokeLiveGrant whose losing call still overwrites the time', async () => {
    const inner = memoryAuthServerStore();
    const overwrites: AuthServerStore = {
      ...inner,
      revokeLiveGrant: async (id, at) => {
        const grant = await inner.getGrant(id);
        const won = await inner.revokeLiveGrant?.(id, at);
        if (grant !== null) await inner.putGrant({ ...grant, revokedAt: at });
        return won === true;
      },
    };
    await expect(check('revokeLiveGrant answers true only').run(overwrites)).rejects.toThrow();
  });

  test('a revokeLiveGrant that reads, then writes in a separate step', async () => {
    const inner = memoryAuthServerStore();
    const readThenWrite: AuthServerStore = {
      ...inner,
      revokeLiveGrant: async (id, at) => {
        const grant = await inner.getGrant(id);
        if (grant === null || grant.revokedAt !== null) return false;
        await inner.revokeGrant(id, at);
        return true;
      },
    };
    await expect(check('revokeLiveGrant answers true only').run(readThenWrite)).rejects.toThrow();
  });

  test('a revokeGrants that ignores the client', async () => {
    const revoke = check('revokes by id and by subject');
    await expect(revoke.run(clientBlind())).rejects.toThrow();
    await revoke.run(memoryAuthServerStore());
  });

  // Two ways to break it: dynamic clients piling up forever, or a client still in use swept away
  // mid-authorization (its pending code then names a client that no longer exists).
  test('a purge that never removes a client, or removes one still named', async () => {
    const purge = check('self-registered client past the idle window');
    const keepsClients = (): AuthServerStore => ({
      ...memoryAuthServerStore(),
      purge: async () => 0,
    });
    // Sweeps every old self-registered client, named by a grant, code or device code or not.
    const sweepsNamed = (): AuthServerStore => {
      const inner = memoryAuthServerStore();
      const created = new Map<string, Date>();
      const gone = new Set<string>();
      return {
        ...inner,
        putClient: async (client) => {
          created.set(client.clientId, client.createdAt);
          await inner.putClient(client);
        },
        getClient: async (id) => (gone.has(id) ? null : inner.getClient(id)),
        purge: async (before, idle) => {
          for (const [id, at] of created) {
            if (id.startsWith('d_') && at.getTime() < idle.getTime()) gone.add(id);
          }
          return inner.purge(before, idle);
        },
      };
    };
    await expect(purge.run(keepsClients())).rejects.toThrow();
    await expect(purge.run(sweepsNamed())).rejects.toThrow();
    await purge.run(memoryAuthServerStore());
  });

  test('every check has a name of its own', () => {
    const names = AUTH_SERVER_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
