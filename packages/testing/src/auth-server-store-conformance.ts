// The `AuthServerStore` contract of `@ultimat3/auth` as shared examples, for a store of your own:
// `behavesLike(authServerStoreConformance, () => store)`. Every single-use rule of an authorization
// server is a STORAGE guarantee — a code taken once, a refresh token rotated once, a device code
// consumed once — so each is asserted as a race, through the port, never as a read then a write.

import { expect, test } from 'bun:test';
import type { AuthServerStore } from '@ultimat3/auth/adapter';
import {
  at,
  codeRecord,
  deviceRecord,
  grantRecord,
  idOf,
  tokenRecord,
} from './auth-server-store-conformance-records';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface AuthServerStoreCheck {
  readonly name: string;
  run(store: AuthServerStore): Promise<void>;
}

const RACERS = 8;

export const AUTH_SERVER_STORE_CHECKS: readonly AuthServerStoreCheck[] = [
  {
    name: 'a client round-trips intact, and an unknown one is null',
    async run(store) {
      const client = {
        clientId: idOf('client'),
        name: 'App',
        secretHash: null,
        authMethod: 'none' as const,
        redirectUris: ['https://app.test/cb', 'http://localhost:4000/cb'],
        grantTypes: ['authorization_code' as const, 'refresh_token' as const],
        scopes: ['read'],
        resources: ['https://as.test/mcp'],
        createdAt: at(0),
      };
      await store.putClient(client);
      expect(await store.getClient(client.clientId)).toEqual(client);
      expect(await store.getClient(idOf('nobody'))).toBeNull();
    },
  },
  {
    name: 'a code is taken fresh once; every later take is a replay',
    async run(store) {
      const [hash, grant] = [idOf('code'), idOf('grant')];
      await store.putCode(codeRecord(hash, grant));
      const first = await store.takeCode(hash, at(1));
      expect([first?.fresh, first?.code.scopes, first?.code.grantId]).toEqual([
        true,
        ['read', 'write'],
        grant,
      ]);
      expect((await store.takeCode(hash, at(2)))?.fresh).toBe(false);
      expect(await store.takeCode(idOf('none'), at(2))).toBeNull();
    },
  },
  {
    name: 'reading a code spends nothing; the take stamps usedAt',
    async run(store) {
      const hash = idOf('peek');
      await store.putCode(codeRecord(hash, idOf('grant')));
      expect(await store.getCode(hash)).toMatchObject({ clientId: 'c1', usedAt: null });
      expect(await store.getCode(idOf('none'))).toBeNull();
      expect((await store.takeCode(hash, at(1)))?.fresh).toBe(true);
      expect((await store.getCode(hash))?.usedAt?.getTime()).toBe(at(1).getTime());
    },
  },
  {
    name: `${RACERS} racing takes of one code spend it exactly once`,
    async run(store) {
      const hash = idOf('race');
      await store.putCode(codeRecord(hash, idOf('grant')));
      const takes = await Promise.all(
        Array.from({ length: RACERS }, () => store.takeCode(hash, at(1))),
      );
      expect(takes.filter((take) => take?.fresh === true)).toHaveLength(1);
    },
  },
  {
    name: 'a refresh token rotates once; the retired one is a replay naming its grant',
    async run(store) {
      const [grant, first, second] = [idOf('grant'), idOf('r1'), idOf('r2')];
      await store.putToken(tokenRecord(first, grant));
      expect(await store.rotateRefresh(first, tokenRecord(second, grant), at(1))).toEqual({
        outcome: 'rotated',
        grantId: grant,
      });
      expect((await store.getToken(first))?.retiredAt?.getTime()).toBe(at(1).getTime());
      expect((await store.getToken(second))?.retiredAt).toBeNull();
      expect(await store.rotateRefresh(first, tokenRecord(idOf('r3'), grant), at(2))).toEqual({
        outcome: 'replayed',
        grantId: grant,
      });
      expect(await store.rotateRefresh(idOf('zz'), tokenRecord(idOf('r4'), grant), at(2))).toEqual({
        outcome: 'unknown',
      });
    },
  },
  {
    name: 'racing rotations of one refresh token rotate it once',
    async run(store) {
      const [grant, live] = [idOf('grant'), idOf('live')];
      await store.putToken(tokenRecord(live, grant));
      const raced = await Promise.all(
        Array.from({ length: RACERS / 2 }, () =>
          store.rotateRefresh(live, tokenRecord(idOf('next'), grant), at(3)),
        ),
      );
      expect(raced.filter((rotation) => rotation.outcome === 'rotated')).toHaveLength(1);
    },
  },
  {
    name: 'a grant revokes by id and by subject, one client or all, and counts only live ones',
    async run(store) {
      const subject = idOf('subject');
      const [g1, g2, g3] = [idOf('g1'), idOf('g2'), idOf('g3')];
      await store.putGrant(grantRecord(g1, subject));
      await store.putGrant(grantRecord(g2, subject, 'c2'));
      await store.putGrant(grantRecord(g3, subject, 'c3'));
      await store.revokeGrant(g1, at(1));
      expect((await store.getGrant(g1))?.revokedAt?.getTime()).toBe(at(1).getTime());
      expect(await store.revokeGrants({ subject, clientId: 'c2' }, at(2))).toBe(1);
      expect(await store.revokeGrants({ subject }, at(3))).toBe(1);
      expect(await store.revokeGrants({ subject }, at(4))).toBe(0);
      expect((await store.getGrant(g1))?.revokedAt?.getTime()).toBe(at(1).getTime());
    },
  },
  {
    name: 'touchGrant restarts the idle window',
    async run(store) {
      const id = idOf('touch');
      await store.putGrant(grantRecord(id, idOf('subject')));
      await store.touchGrant(id, at(50));
      expect((await store.getGrant(id))?.refreshedAt.getTime()).toBe(at(50).getTime());
    },
  },
  {
    name: "a device poll answers the row before its stamp, and another client's poll is null",
    async run(store) {
      const device = idOf('device');
      await store.putDevice(deviceRecord(device, idOf('user-code')));
      expect((await store.pollDevice(device, 'c1', at(1)))?.lastPolledAt).toBeNull();
      expect(await store.pollDevice(device, 'c2', at(4))).toBeNull();
      expect((await store.pollDevice(device, 'c1', at(6)))?.lastPolledAt?.getTime()).toBe(
        at(1).getTime(),
      );
    },
  },
  {
    name: 'a device code is decided once and consumed once, under a race',
    async run(store) {
      const [device, userCode] = [idOf('device'), idOf('user-code')];
      await store.putDevice(deviceRecord(device, userCode));
      expect((await store.deviceByUserCode(userCode))?.deviceCodeHash).toBe(device);
      const decided = await store.decideDevice(
        userCode,
        { status: 'approved', subject: 'u1', scopes: ['read'] },
        at(7),
      );
      expect(decided).toMatchObject({ status: 'approved', subject: 'u1', grantedScopes: ['read'] });
      expect(await store.decideDevice(userCode, { status: 'denied' }, at(8))).toBeNull();
      const consumed = await Promise.all(
        Array.from({ length: RACERS }, () => store.consumeDevice(device, at(9))),
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
    },
  },
  {
    name: 'an expired device code cannot be decided',
    async run(store) {
      const userCode = idOf('user-code');
      await store.putDevice(deviceRecord(idOf('device'), userCode));
      expect(await store.decideDevice(userCode, { status: 'denied' }, at(600))).toBeNull();
    },
  },
  {
    name: 'purge removes what expired and what sat idle, and keeps what is live',
    async run(store) {
      const [code, token, idle, live] = [idOf('old'), idOf('t-old'), idOf('idle'), idOf('live')];
      await store.putCode(codeRecord(code, idOf('grant')));
      await store.putToken(tokenRecord(token, idOf('grant'), 'access'));
      await store.putGrant(grantRecord(idle, idOf('subject')));
      await store.putGrant({ ...grantRecord(live, idOf('subject')), refreshedAt: at(5000) });
      expect(await store.purge(at(200), at(-1))).toBeGreaterThanOrEqual(1);
      expect([await store.getCode(code), (await store.getToken(token))?.tokenHash]).toEqual([
        null,
        token,
      ]);
      expect(await store.purge(at(4000), at(1))).toBeGreaterThanOrEqual(2);
      expect([await store.getToken(token), await store.getGrant(idle)]).toEqual([null, null]);
      expect((await store.getGrant(live))?.id).toBe(live);
    },
  },
];

export const authServerStoreConformance: SharedExamples<
  AuthServerStore | Promise<AuthServerStore>
> = sharedExamples('an authorization-server store', (subject) => {
  for (const check of AUTH_SERVER_STORE_CHECKS) {
    test(check.name, async () => {
      await check.run(await subject());
    });
  }
});
