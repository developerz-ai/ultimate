// The sync node over a recording socket, and the frames a test reads off it: what the drain and
// eviction suites share (`sync-drain.test.ts`, `sync-drain-evict.test.ts`).

import { frozenClock } from '@ultimat3/core';
import { queryHash } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub, type Topic } from './channel';
import { channel } from './channel-decl';
import { getChannel, registerChannel } from './channel-registry';
import { InProcessTransport } from './fanout';
import type { LiveRow } from './json';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { OPEN_POLICY } from './policy-fake-fixture';
import { PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import { type SyncNode, type SyncWs, syncNode, type WsData } from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

// A foreign failure handed to the subject: test input, never its verdict.
export const POLICY_STORE_DOWN = new TypeError('policy store down');

export const BUILD_ID = 'build-1';
/** A channel declared `events: true`: joining it is joining its presence set. */
export const room = channel('drain-room', {
  params: ['orgId'],
  catchUp: { name: 'roomRead' },
  policy: OPEN_POLICY,
  events: true,
});
export const ROOM: Topic = room.topic({ orgId: 'o1' });
export const ROOM_TARGET = {
  kind: 'channel',
  channel: 'drain-room',
  params: { orgId: 'o1' },
} as const;

export const INPUT = { orgId: 'o1' };
export const QID = queryHash('liveFeed', INPUT);
export const ROWS: readonly LiveRow[] = [{ id: 'p1', orgId: 'o1' }];

export class RecordingWs implements SyncWs {
  readonly sent: Frame[] = [];
  readonly data: WsData;
  closedWith: number | null = null;

  constructor(id: string) {
    this.data = { socketId: id, clientBuildId: BUILD_ID };
  }

  /** Bytes this socket claims are queued. Over the ceiling, `SyncSocket.send` declines. */
  buffered = 0;

  send(message: string): number {
    this.sent.push(decode(message));
    return message.length;
  }

  close(code?: number): void {
    this.closedWith ??= code ?? null;
  }

  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

export interface Harness {
  readonly node: SyncNode;
  readonly presence: PresenceRegistry;
  readonly registry: LiveQueryRegistry;
  readonly sockets: SocketRegistry;
  readonly tick: (ms: number) => void;
  connect(id: string): RecordingWs;
  /** One socket holding both kinds of state a teardown has to release: a room and a live query. */
  seat(id: string): Promise<RecordingWs>;
}

export function harness(
  options: {
    idleTimeoutMs?: number;
    visible?: () => boolean;
    snapshot?: () => Promise<{ rows: readonly LiveRow[]; lsn: string }>;
  } = {},
): Harness {
  // A suite's `afterAll` clears the registry, and this module outlives it in one process.
  if (getChannel(room.name) === undefined) registerChannel(room);
  const clock = frozenClock(0);
  const sockets = new SocketRegistry({
    clock,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const transport = new InProcessTransport({ clock });
  const hub = new ChannelHub({ transport, sockets });
  const presence = new PresenceRegistry({ transport, hub, clock, ttlMs: 30_000 });
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register({
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: options.snapshot ?? (async () => ({ rows: ROWS, lsn: '' })),
    visible: options.visible ?? (() => true),
    matcher: () => ({
      entities: ['posts'],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch ? [patch] : [], refill: false };
      },
    }),
  });
  const node = syncNode({
    hub,
    registry,
    transport,
    buildId: BUILD_ID,
    sockets,
    presence,
    clock,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
  const send = async (ws: RecordingWs, frame: Frame): Promise<void> => {
    node.websocket.message(ws, encode(frame));
    await Bun.sleep(0);
  };
  return {
    node,
    presence,
    registry,
    sockets,
    tick: (ms) => clock.advance(ms),
    connect(id: string): RecordingWs {
      const ws = new RecordingWs(id);
      node.websocket.open(ws);
      return ws;
    },
    async seat(id: string): Promise<RecordingWs> {
      const ws = this.connect(id);
      await send(ws, {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: id,
        target: ROOM_TARGET,
      });
      await send(ws, {
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: `q-${id}`,
        target: { kind: 'query', qid: 'liveFeed', input: INPUT, cursor: null },
      });
      return ws;
    },
  };
}

/** Everything one socket held, asked of the node rather than of the socket table. */
export async function held(app: Harness, id: string): Promise<Record<string, unknown>> {
  return {
    sockets: app.sockets.count,
    members: (await app.presence.list(ROOM)).map((member) => member.id),
    topicMembers: app.sockets.subscriberCount(ROOM),
    subscription: app.registry.subscription(id, `q-${id}`) === undefined ? 'gone' : 'held',
    subscribers: app.registry.subscriberCount(QID),
  };
}

export const NOTHING = {
  sockets: 0,
  members: [],
  topicMembers: 0,
  subscription: 'gone',
  subscribers: 0,
};
