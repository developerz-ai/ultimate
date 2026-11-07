// The upgrade's attack surface: every refusal is decided before `server.upgrade`, so the count of
// upgrades a refused dial reached is the claim, beside the status, the code and the challenge.

import { describe, expect, test } from 'bun:test';
import {
  deviceActor,
  manualScheduler,
  testClock,
  upgradeRequest,
  upgradeTarget,
} from './device-fixture';
import {
  answerDeviceUpgrade,
  bearerToken,
  type DeviceGrant,
  type DeviceTokenResolver,
  type DeviceUpgradeDeps,
} from './device-upgrade';
import { PrincipalSockets } from './principal-sockets';
import { AcceptBudget } from './thundering-herd';

const PATH = '/link';
const GOOD = 'tok-good';

function rig(overrides: Partial<DeviceUpgradeDeps> & { resolveToken?: DeviceTokenResolver } = {}) {
  const clock = testClock();
  const timers = manualScheduler(clock);
  const grant: DeviceGrant = {
    actor: deviceActor('owner'),
    deviceId: 'dev-1',
    expiresAt: clock.now().getTime() + 60_000,
  };
  const accept = new AcceptBudget({ perSecond: 10, burst: 2, clock });
  const deps: DeviceUpgradeDeps = {
    path: PATH,
    allowedOrigins: [],
    resolveToken: (token) => (token === GOOD ? grant : null),
    accept,
    principals: new PrincipalSockets(2),
    rng: () => 0.5,
    clock,
    schedule: timers.schedule,
    authDeadlineMs: 5_000,
    maxPendingUpgrades: 2,
    accepting: () => true,
    newSocketId: (() => {
      let n = 0;
      return () => `s${n++}`;
    })(),
    parked: { count: 0 },
    ...overrides,
  };
  const target = upgradeTarget({ open: () => undefined, close: () => undefined });
  return { deps, target, timers, clock, grant, accept };
}

const codeOf = async (response: Response | undefined): Promise<string | undefined> => {
  if (response === undefined) return undefined;
  const body: unknown = await response.json();
  return (body as { error?: { code?: string } }).error?.code;
};

describe('unit · deviceSocket upgrade refusals', () => {
  test('a good token upgrades, with the tenant taken from the actor', async () => {
    const { deps, target } = rig();
    expect(await answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target)).toBeUndefined();
    expect(target.upgrades).toBe(1);
    expect(target.sockets[0]?.data.tenant).toBe(deviceActor('owner').orgId ?? '');
  });

  test('no token: 401 with the bearer challenge, no upgrade, no budget spent', async () => {
    const { deps, target, accept } = rig();
    const response = await answerDeviceUpgrade(deps, upgradeRequest(PATH, null), target);
    expect(response?.status).toBe(401);
    expect(response?.headers.get('www-authenticate')).toBe('Bearer');
    expect(await codeOf(response)).toBe('X_SOCKET_UNAUTHENTICATED');
    expect(target.upgrades).toBe(0);
    expect(accept.tokens).toBe(2);
  });

  test('a token the resolver refuses: 401 invalid_token, and the accept token is refunded', async () => {
    const { deps, target, accept } = rig();
    const response = await answerDeviceUpgrade(deps, upgradeRequest(PATH, 'forged'), target);
    expect(response?.status).toBe(401);
    expect(response?.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(target.upgrades).toBe(0);
    expect(accept.tokens).toBe(2);
  });

  test('an expired grant is refused even when the resolver returned it', async () => {
    const { deps, target, clock, grant } = rig();
    const expired = { ...grant, expiresAt: clock.now().getTime() - 1 };
    const response = await answerDeviceUpgrade(
      { ...deps, resolveToken: () => expired },
      upgradeRequest(PATH, GOOD),
      target,
    );
    expect(response?.status).toBe(401);
    expect(await codeOf(response)).toBe('X_SOCKET_UNAUTHENTICATED');
    expect(target.upgrades).toBe(0);
  });

  test('past maxSocketsPerActor: 429 X_SOCKET_LIMIT before the upgrade', async () => {
    const { deps, target } = rig();
    expect(await answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target)).toBeUndefined();
    expect(await answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target)).toBeUndefined();
    deps.accept.refund();
    const third = await answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target);
    expect(third?.status).toBe(429);
    expect(await codeOf(third)).toBe('X_SOCKET_LIMIT');
    expect(target.upgrades).toBe(2);
  });

  test('an Origin header is a browser: 403 unless listed exactly', async () => {
    const { deps, target } = rig();
    const browser = upgradeRequest(PATH, GOOD, { origin: 'https://evil.example' });
    const refused = await answerDeviceUpgrade(deps, browser, target);
    expect(refused?.status).toBe(403);
    expect(await codeOf(refused)).toBe('X_SOCKET_ORIGIN_REFUSED');
    const listed = { ...deps, allowedOrigins: ['https://evil.example'] };
    expect(await answerDeviceUpgrade(listed, browser, target)).toBeUndefined();
    expect(target.upgrades).toBe(1);
  });

  test('slow-loris: a resolver that never answers is cut at the deadline with 503', async () => {
    const { deps, target, timers } = rig({
      resolveToken: () => new Promise<DeviceGrant | null>(() => undefined),
    });
    const parked = answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target);
    await Promise.resolve();
    expect(deps.parked.count).toBe(1);
    timers.advance(5_000);
    const response = await parked;
    expect(response?.status).toBe(503);
    expect(await codeOf(response)).toBe('X_SOCKET_AUTH_UNAVAILABLE');
    expect(deps.parked.count).toBe(0);
    expect(target.upgrades).toBe(0);
  });

  test('slow-loris: past maxPendingUpgrades parked dials, the next is shed with a delay', async () => {
    const { deps, target } = rig({
      resolveToken: () => new Promise<DeviceGrant | null>(() => undefined),
      accept: new AcceptBudget({ perSecond: 100, burst: 100 }),
    });
    void answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target);
    void answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target);
    await Promise.resolve();
    const shed = await answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target);
    expect(shed?.status).toBe(503);
    expect(Number(shed?.headers.get('retry-after-ms'))).toBeGreaterThan(0);
  });

  test('a resolver that raises is a 503, not a 401', async () => {
    const { deps, target } = rig({
      resolveToken: () => Promise.reject(new Error('token db down')),
    });
    const response = await answerDeviceUpgrade(deps, upgradeRequest(PATH, GOOD), target);
    expect(response?.status).toBe(503);
    expect(await codeOf(response)).toBe('X_SOCKET_AUTH_UNAVAILABLE');
  });

  test('a drain that lands while the resolver runs is shed, not upgraded', async () => {
    let accepting = true;
    const { deps, target } = rig({
      accepting: () => accepting,
      resolveToken: async () => {
        accepting = false;
        return null;
      },
    });
    const draining = {
      ...deps,
      resolveToken: async () => {
        accepting = false;
        return { actor: deviceActor('owner'), deviceId: 'dev-1' };
      },
    };
    const response = await answerDeviceUpgrade(draining, upgradeRequest(PATH, GOOD), target);
    expect(response?.status).toBe(503);
    expect(target.upgrades).toBe(0);
  });

  test('bearerToken reads the scheme case-insensitively and nothing else', () => {
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});
