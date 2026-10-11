// A page seated on a `sync` node, both ends real: a `LiveClient` and a `syncNode` joined by one
// in-memory websocket, over whatever bus the test hands in. Shared by the unit suite (the fake
// broker) and the live one (a real nats-server behind a relay), so both drive the SAME wiring.
// A `-fixture.ts` file is test material and is excluded from the package tarball.

import type { Clock } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import type { Channel } from './channel-decl';
import type { PresenceEvent } from './channel-presence';
import { type ClientSocket, LiveClient } from './client';
import { ManualScheduler } from './client-harness-fixture';
import { DEFAULT_HEARTBEAT_MS } from './client-heartbeat';
import type { Transport } from './fanout';
import type { JsonObject } from './json';
import { LiveQueryRegistry } from './live-query';
import { PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import { type SyncNode, type SyncWs, syncNode, type WsData } from './sync-node';
import { decode, type Frame } from './sync-protocol';

export const RIG_BUILD_ID = 'build-1';

/** Real timers: the preload freezes `Date.now()`, never `setTimeout`. */
export const waitFor = async (done: () => boolean, polls = 400, everyMs = 2): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(everyMs);
};

/** One websocket, both ends: what the page sends reaches the node, and back. */
class Pipe implements SyncWs {
  readonly data: WsData = { socketId: 'sock-1', clientBuildId: RIG_BUILD_ID };
  readonly fromNode: Frame[] = [];
  readyState = 1;
  #node: SyncNode | null = null;
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;

  attach(node: SyncNode): void {
    this.#node = node;
    node.websocket.open(this);
    this.#open?.();
  }

  // The node's half.
  send(message: string): number {
    this.fromNode.push(decode(message));
    this.#message?.(message);
    return message.length;
  }
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
  close(): void {
    this.readyState = 3;
  }

  /** The page's half, as the `ClientSocket` its `LiveClient` dials. */
  page(): ClientSocket {
    return {
      send: (data) => this.#node?.websocket.message(this, data),
      close: () => this.close(),
      onOpen: (handler) => {
        this.#open = handler;
      },
      onMessage: (handler) => {
        this.#message = handler;
      },
      onClose: () => undefined,
    };
  }
}

export interface OutageRigInput {
  /** The node's bus, already connected. */
  readonly transport: Transport;
  /** Another process's connection to the same bus, already connected. */
  readonly publisher: Transport;
  readonly clock: Clock;
  /** A channel declared `events: true` with one `orgId` param. */
  readonly room: Channel<'orgId'>;
  /** How long `beat()` waits for the node's answer, in 2 ms polls. */
  readonly answerPolls?: number;
}

export async function outageRig(input: OutageRigInput) {
  const { transport, publisher, clock, room } = input;
  const sockets = new SocketRegistry({ clock });
  const hub = new ChannelHub({ transport, sockets });
  const presence = new PresenceRegistry({ transport, hub, clock });
  const node = syncNode({
    hub,
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: RIG_BUILD_ID,
    sockets,
    presence,
    clock,
  });
  await node.start();

  const pipe = new Pipe();
  const timers = new ManualScheduler();
  const errors: unknown[] = [];
  const client = new LiveClient({
    connect: () => pipe.page(),
    buildId: RIG_BUILD_ID,
    catchUp: async () => undefined,
    clock,
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    scheduler: timers.schedule,
    onError: (error) => errors.push(error),
  });
  client.connect();
  pipe.attach(node);

  const events: JsonObject[] = [];
  const rosters: PresenceEvent[] = [];
  const membership = client.holdChannel(
    room,
    { orgId: 'o1' },
    { onEvent: (event) => events.push(event), onPresence: (event) => rosters.push(event) },
  );
  return {
    node,
    presence,
    client,
    membership,
    timers,
    events,
    rosters,
    errors,
    topic: room.topic({ orgId: 'o1' }),
    /** The code of every refusal `ack` the node sent the page, in order. */
    acks: (): string[] =>
      pipe.fromNode.flatMap((frame) =>
        frame.type === 'ack' && frame.error !== null ? [frame.error.code] : [],
      ),
    /** An event from another process: its own connection to the same bus. */
    publish: (event: JsonObject): Promise<void> =>
      new ChannelHub({ transport: publisher, sockets: new SocketRegistry({ clock }) }).publishEvent(
        room,
        { orgId: 'o1' },
        event,
      ),
    stop: async (): Promise<void> => {
      client.close();
      await node.stop();
    },
    /** One client beat, and the node's answer to it: the `hello` reply plus a roster or an `ack`. */
    beat: async (): Promise<void> => {
      const before = pipe.fromNode.length;
      timers.fire();
      await waitFor(() => pipe.fromNode.length > before + 1, input.answerPolls);
    },
  };
}
