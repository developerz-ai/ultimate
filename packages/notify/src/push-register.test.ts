// Native registration through the one authz path (`.as()`): stored against the actor the call ran
// as, rotated without leaving the old token behind, refused for an agent, an anonymous caller, an
// undeclared platform and a token its provider could never take — and an unregister (or a rotation)
// that can only ever reach the caller's own device.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { agentActor, anonymousActor, userActor } from '@ultimat3/core';
import {
  definePermissions,
  knownPermissions,
  permissionDeclarationSites,
  restorePermissions,
} from '@ultimat3/policy';
import type { PushDeviceStore } from './push-device';
import { memoryPushDeviceStore } from './push-device';
import { PUSH_DEVICES_PER_ACTOR, pushRegister, pushUnregister } from './push-register';

// `can()` asserts the permission name when the policy is BUILT: declare the set this file uses and
// restore the one found, never lean on the empty registry (`policy/CLAUDE.md`).
let ambientPermissions: readonly string[] = [];
let ambientSites: Readonly<Record<string, readonly string[]>> = {};

beforeAll(() => {
  ambientPermissions = knownPermissions();
  ambientSites = permissionDeclarationSites();
  definePermissions(['push:subscribe']);
});

afterAll(() => {
  restorePermissions(ambientPermissions, ambientSites);
});

afterEach(() => {
  resetActions();
});

const ana = userActor({ id: 'ana', orgId: 'o1', permissions: ['push:subscribe'] });
const ben = userActor({ id: 'ben', orgId: 'o1', permissions: ['push:subscribe'] });

const IOS = 'AB'.repeat(32);
const IOS_NEXT = 'cd'.repeat(32);
const ANDROID = `fcm-token:${'x'.repeat(140)}`;

interface RegisterBody {
  platform: 'ios' | 'android';
  token: string;
  previousToken?: string;
  locale: string;
  timeZone: string;
}

const input = (overrides: Partial<RegisterBody> = {}): RegisterBody => ({
  platform: 'ios',
  token: IOS,
  locale: 'de',
  timeZone: 'Europe/Berlin',
  ...overrides,
});

function surface(platforms: readonly ['ios', ...('ios' | 'android')[]] = ['ios', 'android']): {
  readonly devices: PushDeviceStore;
  readonly register: ReturnType<typeof pushRegister>;
  readonly unregister: ReturnType<typeof pushUnregister>;
} {
  const devices = memoryPushDeviceStore();
  const options = { permission: 'push:subscribe', platforms, devices } as const;
  return {
    devices,
    register: registerAction('registerDevice', pushRegister(options)),
    unregister: registerAction('unregisterDevice', pushUnregister(options)),
  };
}

const refusal = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('expected a refusal');
};

describe('unit · pushRegister / pushUnregister', () => {
  test('a device is stored against the actor the call ran as, its ios token lowercased', async () => {
    const { devices, register } = surface();
    expect(await register.as(ana, input())).toEqual({ platform: 'ios', token: IOS.toLowerCase() });
    expect(await devices.listFor('ana')).toMatchObject([
      { platform: 'ios', token: IOS.toLowerCase(), actorId: 'ana', locale: 'de' },
    ]);
  });

  test('a rotated token replaces the old one, and only the caller’s own', async () => {
    const { devices, register } = surface();
    await register.as(ana, input());
    await register.as(ben, input({ token: ANDROID, platform: 'android' }));
    await register.as(ana, input({ token: IOS_NEXT, previousToken: IOS }));
    expect((await devices.listFor('ana')).map((device) => device.token)).toEqual([IOS_NEXT]);
    // Ana names Ben's token as her "previous" one: it is absent to her, never deleted.
    await register.as(ana, input({ token: IOS, previousToken: ANDROID, platform: 'android' }));
    expect(await devices.listFor('ben')).toHaveLength(1);
  });

  test('the same phone registered by a second person is theirs now', async () => {
    const { devices, register } = surface();
    await register.as(ana, input());
    await register.as(ben, input());
    expect(await devices.listFor('ana')).toEqual([]);
    expect(await devices.listFor('ben')).toHaveLength(1);
  });

  test(`past ${String(PUSH_DEVICES_PER_ACTOR)} devices the oldest is evicted, never the new one or another person's`, async () => {
    const { devices, register } = surface();
    const hex = (n: number) => n.toString(16).padStart(4, '0').repeat(16);
    for (let n = 0; n < PUSH_DEVICES_PER_ACTOR; n += 1) {
      await devices.save({ ...input({ token: hex(n) }), actorId: 'ana', createdAt: 1_000 + n });
    }
    await devices.save({ ...input({ token: IOS_NEXT }), actorId: 'ben', createdAt: 0 });
    await register.as(ana, input());
    const tokens = (await devices.listFor('ana')).map((device) => device.token);
    expect(tokens).toHaveLength(PUSH_DEVICES_PER_ACTOR);
    expect(tokens).toContain(IOS.toLowerCase());
    expect(tokens).not.toContain(hex(0));
    expect(tokens).toContain(hex(1));
    expect(await devices.listFor('ben')).toHaveLength(1);
  });

  test('a re-register at the cap evicts nothing', async () => {
    const { devices, register } = surface();
    const hex = (n: number) => n.toString(16).padStart(4, '0').repeat(16);
    for (let n = 0; n < PUSH_DEVICES_PER_ACTOR; n += 1) {
      await devices.save({ ...input({ token: hex(n) }), actorId: 'ana', createdAt: 1_000 + n });
    }
    await register.as(ana, input({ token: hex(5) }));
    expect(await devices.listFor('ana')).toHaveLength(PUSH_DEVICES_PER_ACTOR);
  });

  test('an agent, an anonymous caller and an actor without the permission are refused', async () => {
    const { devices, register } = surface();
    const agent = agentActor({ id: 'bot', orgId: 'o1', permissions: ['push:subscribe'] });
    expect(await refusal(() => register.as(agent, input()))).toBe('X_FORBIDDEN');
    expect(await refusal(() => register.as(anonymousActor(), input()))).toBe('X_UNAUTHENTICATED');
    const bare = userActor({ id: 'cy', orgId: 'o1' });
    expect(await refusal(() => register.as(bare, input()))).toBe('X_FORBIDDEN');
    expect(await devices.listFor('bot')).toEqual([]);
  });

  test('a token its provider could never take is refused before it is stored', async () => {
    const { devices, register } = surface();
    // An ios token is spliced into the APNs URL path: a `/` or `?` must never reach it.
    for (const token of ['../../3/device/x'.padEnd(64, 'a'), `${IOS}?x=1`, 'ab'.repeat(10)]) {
      expect(await refusal(() => register.as(ana, input({ token })))).toBe('X_INPUT_INVALID');
    }
    // An FCM token is not hex, and an ios rotation naming one is refused whole.
    expect(await refusal(() => register.as(ana, input({ token: ANDROID })))).toBe(
      'X_INPUT_INVALID',
    );
    expect(await refusal(() => register.as(ana, input({ previousToken: ANDROID })))).toBe(
      'X_INPUT_INVALID',
    );
    expect(await devices.listFor('ana')).toEqual([]);
  });

  test('a platform the app does not ship is refused', async () => {
    const { register } = surface(['ios']);
    expect(
      await refusal(() => register.as(ana, input({ platform: 'android', token: ANDROID }))),
    ).toBe('X_INPUT_INVALID');
  });

  test('unregister removes the caller’s own device and never another person’s', async () => {
    const { devices, register, unregister } = surface();
    await register.as(ana, input());
    expect(await unregister.as(ben, { platform: 'ios', token: IOS })).toEqual({ removed: false });
    expect(await devices.listFor('ana')).toHaveLength(1);
    expect(await unregister.as(ana, { platform: 'ios', token: IOS })).toEqual({ removed: true });
    expect(await unregister.as(ana, { platform: 'ios', token: IOS })).toEqual({ removed: false });
  });
});
