// A fleet in one process for `multi-node.live.test.ts`: a table with a commit position, the WAL
// replicator publishing it onto a real bus, `sync` nodes each on its own bus connection and its own
// `Bun.serve` port, and pages dialling them over real websockets through `LiveClient`. What a page
// was sent is recorded off the wire, so loss and duplication are read from frames, not from state.
// A `-fixture.ts` file is test material and is excluded from the package tarball.

import { frozenClock } from '@ultimat3/core';
import { browserSocket, dialUrl } from './browser-socket';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import { ChannelHub } from './channel';
import { LiveClient, type LiveHandle } from './client';
import type { ClientSocket } from './client-contract';
import type { JsonObject, LiveRow } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { NatsTransport } from './nats-transport';
import { changeFeedReplicator } from './replicator';
import { gatedFeed, stubLock } from './replicator-rig-fixture';
import { SocketRegistry } from './socket';
import { type SyncNode, syncNode } from './sync-node';
import { decode, type Frame } from './sync-protocol';

export const BUILD = 'build-multi-node';
/** The bus's KV bucket for this suite; never the default an app uses. */
export const BUCKET = 'xmultinode';
/** Zero wait: the library redials once `lastConnect + wait <= Date.now()`, and the preload freezes it. */
const NO_WAIT = { base: 0, max: 0, factor: 1, jitter: 'none' } as const;

/** Real timers: the preload freezes `Date.now()`, never `setTimeout`. */
export const waitFor = async (done: () => boolean, polls = 400): Promise<void> => {
  // real-clock: a real nats-server and a real socket answer on their own time
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(10);
};

/** The database: rows and the position of the last commit, read together like a snapshot is. */
export class Table {
  readonly name: string;
  readonly rows = new Map<string, LiveRow>();
  position = 0;

  constructor(name: string) {
    this.name = name;
  }

  /** One committed write, as the WAL decodes it. */
  commit(op: 'insert' | 'update' | 'delete', id: string, fields: JsonObject = {}): ChangeEvent {
    this.position += 1;
    const before = this.rows.get(id) ?? null;
    const after = op === 'delete' ? null : { ...(before ?? {}), id, ...fields };
    if (after === null) this.rows.delete(id);
    else this.rows.set(id, after);
    return {
      table: this.name,
      op,
      before,
      after,
      lsn: formatLsn(this.position),
      txid: String(this.position),
      orgId: null,
      at: 0,
      write: null,
    };
  }

  /** What a reader holding every commit sees, by id. */
  ids(): string[] {
    return [...this.rows.keys()].sort();
  }
}

/** The live query every node registers: the whole table, matched row by row. */
export function feedQuery(table: Table, name: string): LiveQueryDefinition {
  return {
    name,
    entities: [table.name],
    snapshot: async () => ({
      rows: [...table.rows.values()].sort((a, b) => a.id.localeCompare(b.id)),
      lsn: formatLsn(table.position),
    }),
    visible: () => true,
    matcher: () => ({
      entities: [table.name],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch === null ? [] : [patch], refill: false };
      },
    }),
  };
}

export interface FleetNode {
  /** The websocket URL a page dials. */
  readonly url: string;
  readonly node: SyncNode;
  readonly hub: ChannelHub;
  readonly transport: NatsTransport;
  /** Gone at once: sockets ended with no `reconnect` frame, no drain, the bus connection dropped. */
  kill(): Promise<void>;
}

/** A `sync` node of its own: bus connection, socket table, change buffer, listener. */
export async function startNode(busUrl: string, query: LiveQueryDefinition): Promise<FleetNode> {
  const transport = new NatsTransport({ url: busUrl, bucket: BUCKET, backoff: NO_WAIT });
  await transport.connect();
  const clock = frozenClock(Date.now());
  const sockets = new SocketRegistry({ clock });
  const hub = new ChannelHub({ transport, sockets });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer(), clock }).register(query);
  const node = syncNode({ hub, registry, transport, buildId: BUILD, sockets, clock });
  await node.start();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: node.fetch,
    websocket: node.websocket,
  });
  return {
    url: `ws://127.0.0.1:${server.port}${node.path}`,
    node,
    hub,
    transport,
    kill: async () => {
      // `true`: every open socket is ended now — what a SIGKILL leaves the client to find.
      server.stop(true);
      await node.stop();
      await transport.close();
    },
  };
}

/** The WAL replicator on its own bus connection, fed by hand through the gated feed. */
export async function startReplicator(busUrl: string) {
  const transport = new NatsTransport({ url: busUrl, bucket: BUCKET, backoff: NO_WAIT });
  await transport.connect();
  const feed = gatedFeed();
  const replicator = changeFeedReplicator({ feed, lock: stubLock(), transport });
  await replicator.start();
  return {
    /** Publishes one committed change, as the pump does — awaited, so the bus has it. */
    publish: (change: ChangeEvent): Promise<void> => feed.deliver(change),
    stop: async (): Promise<void> => {
      await replicator.stop();
      await transport.close();
    },
  };
}

/** A page: one `LiveClient`, dialling whichever node `target()` names, every frame recorded. */
export function openPage(target: () => string, query: string) {
  const frames: Frame[] = [];
  const errors: unknown[] = [];
  let dials = 0;
  const tap = (socket: ClientSocket): ClientSocket => ({
    ...socket,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (handler) => socket.onOpen(handler),
    onClose: (handler) => socket.onClose(handler),
    onMessage: (handler) =>
      socket.onMessage((data) => {
        frames.push(decode(data));
        handler(data);
      }),
  });
  const client = new LiveClient({
    connect: () => {
      dials += 1;
      return tap(browserSocket(dialUrl({ url: target(), buildId: BUILD })));
    },
    buildId: BUILD,
    heartbeatMs: 0,
    catchUp: async () => undefined,
    backoff: { base: 10, max: 50, factor: 2, jitter: 'none' },
    onError: (error) => errors.push(error),
  });
  client.connect();
  const live: LiveHandle = client.subscribeLive({ name: query }, {});
  return {
    client,
    live,
    frames,
    errors,
    dials: (): number => dials,
    ids: (): string[] =>
      live
        .rows()
        .map((row) => String((row as LiveRow).id))
        .sort(),
    close: (): void => client.close(),
  };
}

export type Page = ReturnType<typeof openPage>;
