// A whole `sync` node and one client socket, in this process, with no port and no network. What
// `x dev --role sync` assembles, minus the listener: the real `LiveQueryRegistry`, the real bridge
// from every `query({ live: true })` the app declared, the real per-subscriber authz, the real
// cursor. The only thing replaced is the socket, and it is replaced by a pair of objects that hand
// each other the same JSON strings a WebSocket would.
//
// Dynamically imported by the `subscribe` fixture, never at module load: a test that never
// subscribes must not pull `@ultimat3/realtime` and `@ultimat3/query` into its process, which is
// the rule every fixture in this package already follows.

import type { Actor } from '@ultimat3/core';
import type {
  ChangeEvent,
  LiveQueryRegistry,
  SyncNode,
  SyncWs,
  UpgradeTarget,
  WsData,
  WsLike,
} from '@ultimat3/realtime';
import { liveNodeUnavailable, upgradeRefused } from './errors';

/** Every frame this end received, in order, already parsed. */
export interface FramePipe {
  readonly received: readonly unknown[];
  send(data: string): void;
}

/**
 * The server half of the pair. `SyncSocket` writes through `WsLike`, so a fake that records what
 * it was handed is the whole of what a node needs to talk to a client that is in the same process.
 * `getBufferedAmount` answers zero: backpressure is a real socket's, and a harness that invented
 * one would fail a test for a reason no production node would.
 */
export class PipeWs implements WsLike {
  readonly sent: string[] = [];
  #deliver: (data: string) => void;
  #closed = false;

  constructor(
    readonly data: WsData,
    deliver: (data: string) => void,
  ) {
    this.#deliver = deliver;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(data: string): number {
    this.sent.push(data);
    // A dropped connection is a socket that still exists and delivers nothing, which is exactly
    // what a client observes: the frames the node believes it sent are counted, and none arrive.
    if (!this.#closed) this.#deliver(data);
    return data.length;
  }

  close(): void {
    this.#closed = true;
  }

  subscribe(): void {}
  unsubscribe(): void {}

  getBufferedAmount(): number {
    return 0;
  }

  /** Cut the wire without closing the socket — `network.drop()`'s server end. */
  cut(): void {
    this.#closed = true;
  }
}

export interface LiveNodeOptions {
  readonly buildId?: string;
  /** Pins the reconnect epoch, so a test can force a refetch by changing it. */
  readonly epoch?: string;
  // No `onMutate`. `SyncNodeOptions` takes one — `{ socket, name, key, seq, input }`, the actor
  // read off the socket — and nothing here needs it: the mutation half of a live subscription is
  // the CLIENT's local store and offline queue, which this driver deliberately does not hold. A
  // forwarded option no test passes is a declaration nothing reads, which is what 4.0.0 spent a
  // major deleting. It arrives with its first caller, in that caller's shape.
}

export interface LiveNodeHandle {
  readonly node: SyncNode;
  readonly registry: LiveQueryRegistry;
  /** Open one client connection as this actor. Resolves once the node has the socket. */
  connect(actor: Actor | null): Promise<LiveConnection>;
  /** Fan one committed change out to every subscriber. Returns the frames the node sent. */
  deliver(change: ChangeEvent): Promise<number>;
  stop(): Promise<void>;
}

export interface LiveConnection {
  readonly ws: PipeWs;
  readonly socketId: string;
  /** Frames this client received, newest last, already decoded. */
  frames(): readonly Record<string, unknown>[];
  /** Hand one frame to the node, exactly as a WebSocket message would arrive. */
  send(frame: Record<string, unknown>): void;
  /** Resolves when every frame the node has scheduled for this socket has been written. */
  settled(): Promise<void>;
  cut(): void;
  close(): void;
}

/**
 * The actor for a connection travels in the upgrade URL rather than in a token, because both ends
 * of this pair are the harness: minting a real credential would test `@ultimat3/auth`'s signer, and
 * a test that has to sign in to assert a row filter is a test about the wrong thing. The node still
 * runs its real `authenticate` seam, its accept budget and its connection ceiling — what is faked
 * is the credential, never the path that reads one.
 */
const ACTORS = new Map<string, Actor | null>();

let sequence = 0;

export async function createLiveNode(options: LiveNodeOptions = {}): Promise<LiveNodeHandle> {
  const core = await import('@ultimat3/core');
  const query = await import('@ultimat3/query');
  const realtime = await import('@ultimat3/realtime');

  const buildId = options.buildId ?? 'test-build';
  const transport = new realtime.InProcessTransport();
  const sockets = new realtime.SocketRegistry();
  const hub = new realtime.ChannelHub({ transport, sockets });
  const registry = new realtime.LiveQueryRegistry({ source: new realtime.RingChangeBuffer() });

  const ctx = core.createContext({ role: 'sync', buildId });
  let live = 0;
  for (const target of query.listQueries()) {
    if (!target.isLive) continue;
    registry.register(
      realtime.liveQueryDefinition(target, {
        ctx,
        ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
      }),
    );
    live += 1;
  }
  // A registry with nothing in it answers every subscribe with "no live query registered" — a
  // working socket serving no reads, which is indistinguishable from a harness that works and an
  // app that declared nothing. Said here, where the count is known.
  if (live === 0) throw liveNodeUnavailable();

  const node = realtime.createSyncNode({
    hub,
    registry,
    transport,
    buildId,
    sockets,
    // A grant always, never `null`: `handleUpgrade` answers 401 to a `null` grant, so returning one
    // for an anonymous connection would refuse the very socket a test asking about anonymous access
    // needs. `anonymousActor()` is how core spells nobody — policy models it as `null`, core models
    // it as an actor, and this is core's side of that seam.
    authenticate: (request: Request) =>
      Promise.resolve({
        actor:
          ACTORS.get(new URL(request.url).searchParams.get('c') ?? '') ?? core.anonymousActor(),
      }),
  });
  await node.start();

  const connections: LiveConnection[] = [];

  return {
    node,
    registry,
    deliver: (change) => registry.deliver(change),

    connect: async (actor) => {
      sequence += 1;
      const key = `c${String(sequence)}`;
      ACTORS.set(key, actor);
      let data: WsData | undefined;
      const target: UpgradeTarget = {
        upgrade: (_request: Request, upgradeOptions: { data: WsData }) => {
          data = upgradeOptions.data;
          return true;
        },
      };
      // `/_x/sync` is `SyncNodeOptions.path`'s default and `handleUpgrade` answers 404 to
      // anything else. The `c` parameter is this connection's actor key — see `ACTORS` above.
      const refusal = await node.fetch(new Request(`http://sync.test/_x/sync?c=${key}`), target);
      // A refusal is a REAL one: the accept budget, the connection ceiling or `ready()`. Reported
      // with what the node answered rather than as "no live query", which is a different failure
      // and was this line's error until 2026-08-20. Thrown rather than asserted through a namespace
      // import, which cannot narrow (TS2775).
      if (data === undefined) throw upgradeRefused(refusal?.status);
      const received: Record<string, unknown>[] = [];
      const ws = new PipeWs(data, (raw) => {
        received.push(JSON.parse(raw) as Record<string, unknown>);
      });
      node.websocket.open(ws as unknown as SyncWs);
      const connection: LiveConnection = {
        ws,
        socketId: data.socketId,
        frames: () => received,
        send: (frame) => {
          node.websocket.message(ws as unknown as SyncWs, JSON.stringify(frame));
        },
        /**
         * `message` dispatches into a floating async task — `void (async () => …)()` — so a caller
         * asserting straight after `send` would be reading frames that have not been routed.
         *
         * A MACROTASK yield, not a count of microtask turns. Counting turns is a number that is
         * right until someone adds an `await`, and it fails as a flake: the first version drained 32
         * turns and worked against a two-line query while `examples/dummy`'s feed — a repository, a
         * cache lookup and a policy pass deeper — resolved nothing inside it, so the harness read an
         * empty frame list as "the node answered nothing". One `setImmediate` drains the entire
         * microtask queue however deep it is; the loop then repeats until the frame count has
         * stopped moving for two yields, which is what covers a chain that goes quiet and then
         * produces again.
         *
         * Bounded, because a harness that spins forever on a node that will never answer is worse
         * than one that gives up and lets the assertion say what is missing. No timer: the preload
         * freezes the clock this suite runs on, and a sleep would be a race dressed as a wait.
         */
        settled: async () => {
          let quiet = 0;
          for (let yields = 0; yields < 64 && quiet < 2; yields += 1) {
            const before = received.length;
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            quiet = received.length === before ? quiet + 1 : 0;
          }
        },
        cut: () => {
          ws.cut();
        },
        close: () => {
          node.websocket.close(ws as unknown as SyncWs);
          ACTORS.delete(key);
        },
      };
      connections.push(connection);
      return connection;
    },

    stop: async () => {
      for (const connection of connections) connection.close();
      await node.stop();
    },
  };
}
