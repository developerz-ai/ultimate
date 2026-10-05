// Ordering, not policy. Bun runs `websocket.open` SYNCHRONOUSLY inside `server.upgrade` and does
// not return until it has (measured on bun 1.4.0), so a grant recorded on the line after the
// upgrade is one the socket was already built without — `actor: null` on every authenticated
// connection, and no sweep repairs it because a grant with no `expiresAt` never expires.

import { describe, expect, test } from 'bun:test';
import {
  type Actor,
  configureLifecycle,
  frozenClock,
  markReady,
  registerReadinessCheck,
  resetLifecycle,
  userActor,
} from '@ultimat3/core';
import type { SyncAuthenticator, SyncGrant } from './sync-auth';
import { handleUpgrade, type UpgradeDeps, type UpgradeTarget, type WsData } from './sync-upgrade';
import { AcceptBudget } from './thundering-herd';

const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });
const SOCKET_ID = 'sock-1';
const request = new Request('http://node/_x/sync');

interface Rig {
  readonly deps: UpgradeDeps;
  readonly server: UpgradeTarget;
  /** The book itself, so a test can ask what survived. */
  readonly granted: Map<string, SyncGrant>;
  /**
   * Who the book held at the instant `upgrade()` was called — the only moment that matters, since
   * that call is where Bun builds the socket and reads the actor off this book.
   */
  seenByOpen(): readonly string[] | null;
}

function rig(options: { accepts: boolean; authenticate?: SyncAuthenticator }): Rig {
  const granted = new Map<string, SyncGrant>();
  let atUpgrade: readonly string[] | null = null;
  const server: UpgradeTarget = {
    upgrade(_request: Request, upgradeOptions: { data: WsData }): boolean {
      // Bun's `open` runs here. What it can see is what the node can put on the socket.
      atUpgrade = [...granted.keys()].map((id) => `${id}:${granted.get(id)?.actor.id ?? 'none'}`);
      expect(upgradeOptions.data.socketId).toBe(SOCKET_ID);
      return options.accepts;
    },
    // The box itself: the peer the readiness test below reads the check names as.
    requestIP: () => ({ address: '127.0.0.1' }),
  };
  const deps: UpgradeDeps = {
    path: '/_x/sync',
    buildId: 'build-1',
    maxConnections: 10,
    accept: new AcceptBudget({ perSecond: 100, burst: 100, clock: frozenClock(0) }),
    rng: () => 0.5,
    ready: () => true,
    socketCount: () => 0,
    newSocketId: () => SOCKET_ID,
    healthDetailPeers: ['loopback'],
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
    onGranted: (socketId, grant) => {
      granted.set(socketId, grant);
    },
    onUngranted: (socketId) => {
      granted.delete(socketId);
    },
  };
  return { deps, server, granted, seenByOpen: () => atUpgrade };
}

describe('the grant is recorded before the socket exists, not after', () => {
  test('an upgrade that takes can already be read for its actor', async () => {
    const target = rig({ accepts: true, authenticate: async () => ({ actor: alice }) });

    expect(await handleUpgrade(target.deps, request, target.server)).toBeUndefined();

    // Recorded after the upgrade, this is `[]`: the socket was built out of an empty book, so
    // every policy under it — the topic guard, `authorize`, `visible`, the per-tenant cap — was
    // asked about `null` for the life of the connection.
    expect(target.seenByOpen()).toEqual(['sock-1:alice']);
    expect(target.granted.get(SOCKET_ID)?.actor).toBe(alice);
  });

  test('an upgrade the server refuses gives the grant back', async () => {
    const target = rig({ accepts: false, authenticate: async () => ({ actor: alice }) });

    const response = await handleUpgrade(target.deps, request, target.server);

    // The half that makes recording first safe: only a `close` callback ever deletes a grant, and
    // an upgrade that never took gets no callback — so without the release this entry, its actor
    // and its `refresh` closure are held for the life of the process, once per refused upgrade.
    expect(response?.status).toBe(426);
    expect(target.granted.size).toBe(0);
  });

  test('no authenticator records nothing, and releases nothing either', async () => {
    const target = rig({ accepts: true });

    expect(await handleUpgrade(target.deps, request, target.server)).toBeUndefined();

    expect(target.seenByOpen()).toEqual([]);
    expect(target.granted.size).toBe(0);
  });
});

describe('the connection cap is re-asked after authenticate, not only before it', () => {
  test('ten upgrades parked in a token service cannot all land on a node that holds two', async () => {
    // The interleaving a restart storm produces: every client of a node that just died dials this
    // one at once, and each request parks inside `authenticate` — a token service round trip —
    // having passed the cap check while the node still held nothing. Read once, the cap decides
    // about a socket count that is already history, and the node ends up with as many sockets as
    // there were parked requests. `ready` was re-asked here from the start and the count was not,
    // which is the same staleness the comment above it describes.
    let sockets = 0;
    let release = (): void => undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server: UpgradeTarget = {
      upgrade(): boolean {
        // Bun runs `websocket.open` synchronously inside this call and `open` is where the node
        // does `sockets.add`, so the count moves with no await in between — which is what makes a
        // recheck on the line above it sound.
        sockets += 1;
        return true;
      },
      requestIP: () => null,
    };
    const deps: UpgradeDeps = {
      path: '/_x/sync',
      buildId: 'build-1',
      maxConnections: 2,
      accept: new AcceptBudget({ perSecond: 1_000, burst: 1_000, clock: frozenClock(0) }),
      rng: () => 0.5,
      ready: () => true,
      socketCount: () => sockets,
      newSocketId: () => `sock-${sockets}`,
      healthDetailPeers: ['loopback'],
      authenticate: async (): Promise<SyncGrant> => {
        await parked;
        return { actor: alice };
      },
      onGranted: () => undefined,
      onUngranted: () => undefined,
    };

    const upgrades = Array.from({ length: 10 }, () => handleUpgrade(deps, request, server));
    release();
    const answers = await Promise.all(upgrades);

    expect(sockets).toBe(2);
    // The other eight are told to come back, with the same delay a full node always attaches.
    const shed = answers.filter((answer) => answer?.status === 503);
    expect(shed.length).toBe(8);
    expect(shed[0]?.headers.get('retry-after-ms')).not.toBeNull();
  });
});

/**
 * The URL half of the build id. The `hello` frame is the other half (`sync-frames.test.ts`), and
 * the two must agree on what "absent" means: a dial without `?build=` records the node's own id,
 * which is "current until the hello says otherwise" — never "current forever".
 */
describe('the upgrade records ?build= when the dial carries one', () => {
  function upgrade(url: string): Promise<WsData | null> {
    let data: WsData | null = null;
    const server: UpgradeTarget = {
      upgrade(_request: Request, upgradeOptions: { data: WsData }): boolean {
        data = upgradeOptions.data;
        return true;
      },
      requestIP: () => null,
    };
    return handleUpgrade(rig({ accepts: true }).deps, new Request(url), server).then(() => data);
  }

  test('a dial with ?build= is recorded as that build', async () => {
    const data = await upgrade('http://node/_x/sync?build=build-2');
    expect(data?.clientBuildId).toBe('build-2');
  });

  test('a dial without it is recorded as this node, for the hello to correct', async () => {
    const data = await upgrade('http://node/_x/sync');
    expect(data?.clientBuildId).toBe('build-1');
  });
});

// The caller's address is resolved ONCE, where the request still exists, and rides the socket:
// it is the only subject an anonymous live reader's rate limit can be keyed on.
describe('the upgrade resolves the caller address once and hands it to the socket', () => {
  const dial = async (deps: UpgradeDeps, peer: string | null): Promise<WsData | null> => {
    let data: WsData | null = null;
    const server: UpgradeTarget = {
      upgrade(_request: Request, upgradeOptions: { data: WsData }): boolean {
        data = upgradeOptions.data;
        return true;
      },
      requestIP: () => (peer === null ? null : { address: peer }),
    };
    const forwarded = new Request('http://node/_x/sync', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    await handleUpgrade(deps, forwarded, server);
    return data;
  };

  test('with no resolver the socket address is the caller', async () => {
    expect((await dial(rig({ accepts: true }).deps, '198.51.100.4'))?.clientAddress).toBe(
      '198.51.100.4',
    );
    expect((await dial(rig({ accepts: true }).deps, null))?.clientAddress).toBeNull();
  });

  test("the deployment's resolver decides — the proxy hops the HTTP read honours", async () => {
    const deps: UpgradeDeps = {
      ...rig({ accepts: true }).deps,
      clientAddressOf: (incoming, socketAddress) =>
        incoming.headers.get('x-forwarded-for') ?? socketAddress,
    };
    expect((await dial(deps, '10.0.0.2'))?.clientAddress).toBe('203.0.113.7');
  });
});

// `health.readiness: 'process'` reaches the sync node's own `/readyz` too, and `?deep=1` still
// answers on the dependencies — the same two answers the web role's native route gives.
describe('the sync node honours the readiness mode', () => {
  test("a failing check is 200 in 'process' mode and 503 with ?deep=1", async () => {
    resetLifecycle();
    try {
      configureLifecycle({ readiness: 'process' });
      registerReadinessCheck('database', () => false);
      markReady();
      const target = rig({ accepts: true });
      const shallow = await handleUpgrade(
        target.deps,
        new Request('http://node/readyz'),
        target.server,
      );
      const deep = await handleUpgrade(
        target.deps,
        new Request('http://node/readyz?deep=1'),
        target.server,
      );
      expect(shallow?.status).toBe(200);
      if (shallow === undefined) return expect.unreachable('/readyz answered nothing');
      expect(((await shallow.json()) as { checks: object }).checks).toEqual({
        database: 'failing',
      });
      expect(deep?.status).toBe(503);
    } finally {
      resetLifecycle();
    }
  });
});
