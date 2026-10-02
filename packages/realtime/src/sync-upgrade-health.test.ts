// The sync role's own listener answers `/healthz` and `/readyz` outside every gate, so the body is
// a stranger's to read: the verdict for everyone, the detail for a listed peer on a direct socket.
// Core owns the rule (`healthBody`, `healthPeerListed`); this is the sync node calling it.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, markReady, resetLifecycle } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry } from './socket';
import { createSyncNode } from './sync-node';
import { handleUpgrade, type UpgradeDeps, type UpgradeTarget } from './sync-upgrade';
import { AcceptBudget } from './thundering-herd';

afterEach(() => {
  resetLifecycle();
});

const from = (address: string | null): UpgradeTarget => ({
  upgrade: () => true,
  requestIP: () => (address === null ? null : { address }),
});

const deps = (overrides: Partial<UpgradeDeps> = {}): UpgradeDeps => ({
  path: '/_x/sync',
  buildId: 'build-9',
  maxConnections: 100,
  accept: new AcceptBudget({ perSecond: 100, burst: 100, clock: frozenClock(0) }),
  rng: () => 0.5,
  ready: () => true,
  socketCount: () => 0,
  newSocketId: () => 'sock-1',
  healthDetailPeers: ['loopback'],
  onGranted: () => undefined,
  onUngranted: () => undefined,
  ...overrides,
});

async function ask(
  path: string,
  address: string | null,
  headers: Record<string, string> = {},
  overrides: Partial<UpgradeDeps> = {},
): Promise<{ status: number; body: Record<string, unknown>; cache: string | null }> {
  const response = await handleUpgrade(
    deps(overrides),
    new Request(`http://node${path}`, { headers }),
    from(address),
  );
  if (response === undefined) return expect.unreachable('a health path never upgrades');
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cache: response.headers.get('cache-control'),
  };
}

const VERDICT = ['ready', 'role', 'state'];

describe('the sync listener tells a stranger the verdict and nothing else', () => {
  for (const path of ['/healthz', '/readyz', '/readyz?deep=1']) {
    test(`${path} from an unlisted peer`, async () => {
      markReady();
      const answer = await ask(path, '203.0.113.9');
      expect(answer.status).toBe(200);
      expect(Object.keys(answer.body).sort()).toEqual(VERDICT);
      expect(answer.body['role']).toBe('sync');
      expect(JSON.stringify(answer.body)).not.toContain('build');
      expect(answer.cache).toBe('no-store');
    });
  }

  test('a private-network peer is a stranger by default; no address at all is one too', async () => {
    markReady();
    expect(Object.keys((await ask('/healthz', '10.42.0.7')).body).sort()).toEqual(VERDICT);
    expect(Object.keys((await ask('/healthz', null)).body).sort()).toEqual(VERDICT);
  });

  test('the status is still everyone’s: a node that is not ready answers 503', async () => {
    markReady();
    const answer = await ask('/readyz', '203.0.113.9', {}, { ready: () => false });
    expect(answer.status).toBe(503);
    expect(Object.keys(answer.body).sort()).toEqual(VERDICT);
  });
});

describe('the sync listener tells a listed peer the whole report', () => {
  test('the box itself, by default', async () => {
    markReady();
    const answer = await ask('/readyz', '127.0.0.1');
    expect(answer.body).toMatchObject({ role: 'sync', state: 'ready', inflight: 0, checks: {} });
    expect(answer.body).toHaveProperty('buildId');
    expect(answer.body).toHaveProperty('uptimeMs');
  });

  test('a class or an exact address the app listed; an empty list tells nobody', async () => {
    markReady();
    const listed = { healthDetailPeers: ['loopback', 'private'] };
    expect(await ask('/healthz', '10.42.0.7', {}, listed)).toHaveProperty('body.buildId');
    expect(await ask('/healthz', '203.0.113.9', {}, listed)).not.toHaveProperty('body.buildId');
    const nobody = await ask('/healthz', '127.0.0.1', {}, { healthDetailPeers: [] });
    expect(Object.keys(nobody.body).sort()).toEqual(VERDICT);
  });

  // A proxy on this box makes every caller's socket loopback, and this node declares no trusted
  // proxy to read the header through — so a forwarded request is never told the detail.
  for (const header of [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'via',
  ]) {
    test(`a request carrying ${header} gets the verdict only, even from loopback`, async () => {
      markReady();
      const answer = await ask('/readyz', '127.0.0.1', { [header]: 'for=203.0.113.9' });
      expect(Object.keys(answer.body).sort()).toEqual(VERDICT);
    });
  }
});

describe('createSyncNode forwards the peer list', () => {
  const node = (healthDetailPeers?: readonly string[]) => {
    const sockets = new SocketRegistry();
    const transport = new InProcessTransport();
    return createSyncNode({
      hub: new ChannelHub({ transport, sockets }),
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      transport,
      buildId: 'build-9',
      sockets,
      ...(healthDetailPeers === undefined ? {} : { healthDetailPeers }),
    });
  };
  const body = async (response: Response | undefined): Promise<Record<string, unknown>> =>
    (await response?.json()) as Record<string, unknown>;

  test('the default is the box itself', async () => {
    const request = new Request('http://node/healthz');
    expect(await body(await node().fetch(request, from('127.0.0.1')))).toHaveProperty('buildId');
    expect(await body(await node().fetch(request, from('10.42.0.7')))).not.toHaveProperty(
      'buildId',
    );
  });

  test('a declared list replaces it', async () => {
    const request = new Request('http://node/healthz');
    const declared = node(['private']);
    expect(await body(await declared.fetch(request, from('10.42.0.7')))).toHaveProperty('buildId');
    expect(await body(await declared.fetch(request, from('127.0.0.1')))).not.toHaveProperty(
      'buildId',
    );
  });
});
