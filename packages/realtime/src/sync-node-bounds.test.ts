// Every numeric option `createSyncNode` accepts, refused where the node is BUILT — not inside a
// callback the runtime invokes per connection.
//
// Failure case first, and the failure is the timing rather than the missing check. `SyncSocket`
// screens its own four ceilings, but `sync-node` forwards them into `websocket.open`, which Bun
// runs synchronously inside `server.upgrade` — so a node built with `maxBufferedBytes: NaN` boots
// clean, answers `/healthz` and `/readyz`, reports `ready`, and then throws `X_INVARIANT` out of
// every upgrade for the life of the process, holding zero sockets. Measured before the fix:
// `createSyncNode` threw? false; the first upgrade threw `X_INVARIANT`; sockets held = 0. A
// misconfiguration that fails at boot is a rollback; one that fails per connection is an outage
// whose cause is one stack frame inside the runtime.
//
// The second half is the grant: `handleUpgrade` records it BEFORE `server.upgrade` (it has to —
// `open` reads it) and gives it back only on the `false` branch, so a throw out of `open` left one
// `GrantBook` entry per connection attempt. `sweepGrants` never reaps it, because
// `authenticate: async () => ({ actor })` carries no `expiresAt`.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, UltimateError, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, type WsLike } from './socket';
import { GrantBook, type SyncGrant } from './sync-auth';
import {
  createSyncNode,
  type SyncNode,
  type SyncNodeOptions,
  type SyncWs,
  type UpgradeTarget,
  type WsData,
} from './sync-node';
import { handleUpgrade, type UpgradeDeps } from './sync-upgrade';
import { AcceptBudget } from './thundering-herd';

const BUILD_ID = 'build-1';
const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });

/** Every shape `Number(process.env.X)` / `parseInt` / a JSON `null` hands a config reader. */
const NOT_A_CEILING = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

/** The four ceilings this node forwards to every socket it builds. */
const SOCKET_CEILINGS = [
  'maxFramesPerSecond',
  'frameBurst',
  'maxBufferedBytes',
  'maxDroppedFrames',
] as const;

class FakeWs implements WsLike {
  data!: WsData;
  send(raw: string): number {
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

function nodeWith(extra: Partial<SyncNodeOptions>): () => SyncNode {
  return function build(): SyncNode {
    const sockets = new SocketRegistry();
    const transport = new InProcessTransport();
    return createSyncNode({
      hub: new ChannelHub({ transport, sockets }),
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      transport,
      buildId: BUILD_ID,
      sockets,
      clock: frozenClock(0),
      ...extra,
    });
  };
}

/** Accepts every upgrade and opens the socket INSIDE it, synchronously, the way Bun does. */
function upgradeTarget(node: SyncNode): UpgradeTarget {
  return {
    upgrade(_request: Request, options: { data: WsData }): boolean {
      const ws = new FakeWs();
      ws.data = options.data;
      node.websocket.open(ws as unknown as SyncWs);
      return true;
    },
  };
}

describe('a sync node built on a ceiling that is not a number', () => {
  for (const option of SOCKET_CEILINGS) {
    test(`a non-finite ${option} is refused by createSyncNode, not by every upgrade`, () => {
      for (const value of NOT_A_CEILING) {
        expect(nodeWith({ [option]: value })).toThrow(UltimateError);
      }
    });
  }

  test('the refusal names the option and the value, so it is one edit', () => {
    let thrown: unknown;
    try {
      nodeWith({ maxBufferedBytes: Number.NaN })();
    } catch (error: unknown) {
      thrown = error;
    }
    const rendered = thrown instanceof UltimateError ? `${thrown.cause} ${thrown.fix}` : '';
    expect(rendered).toContain('maxBufferedBytes');
    expect(rendered).toContain('NaN');
  });

  test('a finite node still boots and still upgrades — the screen refuses numbers, not nodes', async () => {
    // Non-vacuity: a `createSyncNode` that threw on everything would satisfy every case above,
    // and so would one that never built a socket.
    const node = nodeWith({
      maxBufferedBytes: 4096,
      maxDroppedFrames: 1,
      maxFramesPerSecond: 8,
      frameBurst: 16,
    })();
    await node.start();
    const target = upgradeTarget(node);
    expect(
      await node.fetch(new Request('http://localhost/_x/sync?build=build-1'), target),
    ).toBeUndefined();
    expect(node.sockets.count).toBe(1);
    // The ceiling reached the socket rather than being screened and dropped.
    expect([...node.sockets.all()][0]?.frameBudget.perSecond).toBe(8);
    await node.stop();
  });
});

describe('a grant on an upgrade that never opens a socket', () => {
  const depsFor = (grants: GrantBook, authenticate: () => Promise<SyncGrant | null>): UpgradeDeps =>
    ({
      path: '/_x/sync',
      buildId: BUILD_ID,
      maxConnections: 10,
      accept: new AcceptBudget({ perSecond: 100, burst: 100, clock: frozenClock(0) }),
      rng: () => 0.5,
      ready: () => true,
      socketCount: () => 0,
      newSocketId: () => `s${grants.size}`,
      authenticate,
      onGranted: (socketId, grant) => grants.set(socketId, grant),
      onUngranted: (socketId) => grants.delete(socketId),
    }) satisfies UpgradeDeps;

  test('a throw out of server.upgrade gives the grant back', async () => {
    // Bun runs `websocket.open` synchronously inside `server.upgrade`, so a throw from `open`
    // arrives here. Nothing else can free the entry: there is no `close` callback for a socket
    // that never opened, and this grant has no `expiresAt`, so no re-auth pass ever visits it.
    const grants = new GrantBook();
    const deps = depsFor(grants, async () => ({ actor: alice }));
    const server: UpgradeTarget = {
      upgrade(): boolean {
        throw new UltimateError({
          code: 'X_INVARIANT',
          cause: 'the socket refused its own ceiling',
          fix: 'pass a finite ceiling to createSyncNode',
        });
      },
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(
        handleUpgrade(deps, new Request('http://localhost/_x/sync'), server),
      ).rejects.toThrow(UltimateError);
    }
    expect(grants.size).toBe(0);
  });

  test('an upgrade that answers false still gives the grant back, and one that takes keeps it', async () => {
    const grants = new GrantBook();
    const deps = depsFor(grants, async () => ({ actor: alice }));
    const refuses: UpgradeTarget = { upgrade: () => false };
    expect(
      (await handleUpgrade(deps, new Request('http://localhost/_x/sync'), refuses))?.status,
    ).toBe(426);
    expect(grants.size).toBe(0);

    const takes: UpgradeTarget = { upgrade: () => true };
    expect(
      await handleUpgrade(deps, new Request('http://localhost/_x/sync'), takes),
    ).toBeUndefined();
    expect(grants.size).toBe(1);
  });
});
