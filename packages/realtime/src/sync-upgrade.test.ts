// Ordering, not policy. Bun runs `websocket.open` SYNCHRONOUSLY inside `server.upgrade` and does
// not return until it has (measured on bun 1.3.14), so a grant recorded on the line after the
// upgrade is one the socket was already built without — `actor: null` on every authenticated
// connection, and no sweep repairs it because a grant with no `expiresAt` never expires.

import { describe, expect, test } from 'bun:test';
import { type Actor, frozenClock, userActor } from '@ultimat3/core';
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
