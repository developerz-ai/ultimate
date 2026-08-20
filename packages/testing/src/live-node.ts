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
import { liveNodeUnavailable } from './errors';

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
  /** Called for every `mutate` frame the node routes. Omitted, a mutation is acknowledged only. */
  readonly onMutate?: (args: {
    name: string;
    input: unknown;
    actor: Actor | null;
  }) => Promise<void>;
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
    authenticate: (request: Request) =>
      Promise.resolve({
        actor: ACTORS.get(new URL(request.url).searchParams.get('c') ?? '') ?? null,
      }),
    ...(options.onMutate === undefined
      ? {}
      : {
          onMutate: async (args: { name: string; input: unknown; actor: Actor | null }) => {
            await options.onMutate?.(args);
          },
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
      await node.fetch(new Request(`http://sync.test/sync?c=${key}`), target);
      if (data === undefined) throw liveNodeUnavailable();
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
        // `message` dispatches into a floating async task, so a caller that asserted straight
        // after `send` would be asserting on a frame that has not been routed. Two turns of the
        // microtask queue is what the node's own suites wait; a timer would be a sleep.
        settled: async () => {
          for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
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
