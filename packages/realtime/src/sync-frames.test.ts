// The node's inbound surface under the only condition it actually runs in: several frames from one
// socket in flight at once. `sync-node` dispatches every frame as `void (async () => …)()`, so
// nothing upstream orders them — a subscribe/drop pair for one sid could strand the subscription it
// was meant to end.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import type { Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, SyncSocket, type WsLike } from './socket';
import { ackRefOf, createFrameRouter } from './sync-frames';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  readonly closes: (readonly [number, string])[] = [];
  /** Queued bytes this socket claims. Over the ceiling, `SyncSocket.send` declines and returns false. */
  buffered = 0;
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(code = 0, reason = ''): void {
    this.closes.push([code, reason]);
  }
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return this.buffered;
  }
}

/** A promise this test resolves by hand. Never a sleep: ordering is not a duration. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets the microtask chains a fire-and-forget dispatch leaves behind settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });
const rows: readonly Row[] = [{ id: 'p1', orgId: 'o1' }];

interface Rig {
  readonly socket: SyncSocket;
  readonly ws: FakeWs;
  readonly registry: LiveQueryRegistry;
  route(frame: Frame): Promise<void>;
}

function rig(
  options: {
    snapshot?: () => Promise<{ rows: readonly Row[]; lsn: string }>;
    /** Bytes already queued on the socket, so every `send` below is refused by backpressure. */
    buffered?: number;
  } = {},
): Rig {
  const transport = new InProcessTransport();
  const sockets = new SocketRegistry();
  const definition: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: options.snapshot ?? (async () => ({ rows, lsn: formatLsn(1) })),
    visible: () => true,
    matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
  };
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(definition);
  const ws = new FakeWs();
  ws.buffered = options.buffered ?? 0;
  const socket = new SyncSocket({
    ws,
    id: 'sock-1',
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: alice,
    maxBufferedBytes: 1_024,
  });
  sockets.add(socket);
  const route = createFrameRouter({
    hub: new ChannelHub({ transport, sockets }),
    registry,
    buildId: 'build-1',
  });
  return { socket, ws, registry, route: (frame) => route(socket, frame) };
}

const subscribeQuery = (sid: string, op: 'add' | 'drop'): Frame => ({
  type: 'subscribe',
  v: PROTOCOL_VERSION,
  op,
  sid,
  target: { kind: 'query', qid: 'liveFeed', input: { orgId: 'o1' }, cursor: null },
});

describe('one sid is one lane, so a drop cannot overtake the add it ends', () => {
  test('add then drop leaves nothing subscribed, however slow the read is', async () => {
    const read = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = rig({ snapshot: () => read.promise });

    const adding = target.route(subscribeQuery('S', 'add'));
    const dropping = target.route(subscribeQuery('S', 'drop'));
    read.resolve({ rows, lsn: formatLsn(1) });
    await Promise.all([adding, dropping]);

    // Unordered, the drop ran first against a book the add had not written to yet: it found
    // nothing, returned, and the add then attached a subscription the client had already ended and
    // no frame can reach — it lives until the socket does.
    expect(target.registry.subscription('sock-1', 'S')).toBeUndefined();
    expect(target.socket.queries.size).toBe(0);
  });

  test('two different sids are not in each other’s way', async () => {
    const read = deferred<{ rows: readonly Row[]; lsn: string }>();
    let reads = 0;
    const target = rig({
      snapshot: () => {
        reads += 1;
        return read.promise;
      },
    });

    const both = Promise.all([
      target.route(subscribeQuery('A', 'add')),
      target.route(subscribeQuery('B', 'add')),
    ]);
    // Both subscribes reached the read before either answered — the shared window is what makes
    // them one read, and a per-socket lane would have made them two round trips end to end.
    await flush();
    expect(reads).toBe(1);
    read.resolve({ rows, lsn: formatLsn(1) });
    await both;

    expect(target.registry.subscription('sock-1', 'A')).toBeDefined();
    expect(target.registry.subscription('sock-1', 'B')).toBeDefined();
  });
});

/**
 * Skew is the client's word against this node's build, and the client has two ways to say it: the
 * upgrade URL's `?build=` (what `sync-upgrade.ts` records) and the `hello` frame's `buildId` (the
 * documented one, `HelloFrame`). Until 2026-09-07 only the URL was read: a socket upgraded without
 * `?build=` defaulted to the node's OWN id, so a client that said `hello` with any build at all was
 * deemed current forever — measured on ai-maxxing, a page sending `buildId: "dev"` in every hello
 * to a node on `46db23f57d6ef969`, and no `update-available` ever came. Either channel works now.
 */
describe('a hello names the build the client is on', () => {
  function hello(buildId: string): Frame {
    return { type: 'hello', v: PROTOCOL_VERSION, buildId, sessionId: null, actorId: null };
  }

  /** `clientBuildId` is what the upgrade recorded; without `?build=` that is the node's own id. */
  function nodeOf(
    clientBuildId: string,
    serverBuildId: string,
  ): { ws: FakeWs; socket: SyncSocket; route: (frame: Frame) => Promise<void> } {
    const transport = new InProcessTransport();
    const sockets = new SocketRegistry();
    const ws = new FakeWs();
    const socket = new SyncSocket({ ws, id: 'sock-1', clientBuildId, serverBuildId, actor: alice });
    sockets.add(socket);
    const route = createFrameRouter({
      hub: new ChannelHub({ transport, sockets }),
      registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
      buildId: serverBuildId,
    });
    return { ws, socket, route: (frame) => route(socket, frame) };
  }

  test('a socket upgraded without ?build= that says hello from another build is told', async () => {
    const { ws, socket, route } = nodeOf('build-2', 'build-2');

    await route(hello('build-1'));

    expect(socket.clientBuildId).toBe('build-1');
    expect(ws.frames.map((frame) => frame.type)).toEqual(['hello', 'update-available']);
  });

  test('a socket upgraded without ?build= that says hello from this build is not', async () => {
    const { ws, route } = nodeOf('build-2', 'build-2');

    for (let i = 0; i < 3; i += 1) await route(hello('build-2'));

    // Three beats, three plain hellos: the client's build and the node's are both fixed for the
    // socket's life, so a beat can only ever hear what the first hello heard.
    expect(ws.frames.map((frame) => frame.type)).toEqual(['hello', 'hello', 'hello']);
  });

  test('the latest hello is the word: a match and then a skew is told on the skew', async () => {
    const { ws, socket, route } = nodeOf('build-2', 'build-2');

    await route(hello('build-2'));
    await route(hello('build-1'));

    // A real client says the same build on every beat; this pins that each hello is READ, not
    // only the first — the record is whatever the client last claimed.
    expect(socket.clientBuildId).toBe('build-1');
    expect(ws.frames.map((frame) => frame.type)).toEqual(['hello', 'hello', 'update-available']);
  });

  test('?build= still works on its own, and the hello re-reports it on every beat', async () => {
    const { ws, route } = nodeOf('build-1', 'build-2');

    await route(hello('build-1'));
    await route(hello('build-1'));

    expect(ws.frames.map((frame) => frame.type)).toEqual([
      'hello',
      'update-available',
      'hello',
      'update-available',
    ]);
  });
});

describe('ackRefOf', () => {
  test('names the sid for a subscribe, and the socket only when the frame is unreadable', () => {
    expect(ackRefOf(subscribeQuery('S', 'add'), 'sock-1')).toBe('S');
    expect(ackRefOf(null, 'sock-1')).toBe('sock-1');
    expect(
      ackRefOf(
        {
          type: 'hello',
          v: PROTOCOL_VERSION,
          buildId: 'b',
          sessionId: null,
          actorId: null,
        },
        'sock-1',
      ),
    ).toBe('sock-1');
  });
});

/**
 * `send` answers `false` when backpressure dropped the frame, and this file's sends threw that
 * answer away. The subscribe reply is the repairable one and the one that was silently wrong: the
 * registry has already seated it and cleared its desync mark by the time the reply is written, so a
 * dropped snapshot left the server believing a client holding no rows was in sync — every later
 * change delivered to it as a PATCH folded onto nothing, forever, on a socket that has since
 * drained.
 */
describe('a reply the socket refuses is not a reply that was delivered', () => {
  test('a dropped subscribe reply desyncs the subscription it seated', async () => {
    const target = rig({ buffered: 4_096 });

    await target.route(subscribeQuery('S', 'add'));

    // The subscription IS seated — that is what makes the lost frame dangerous rather than merely
    // unlucky — so the mark is the only thing that makes the next change re-snapshot it.
    expect(target.registry.subscription('sock-1', 'S')).toBeDefined();
    expect(target.ws.frames).toHaveLength(0);
    expect([...target.socket.desynced]).toEqual(['S']);
  });

  test('a delivered subscribe reply leaves nothing marked', async () => {
    const target = rig();

    await target.route(subscribeQuery('S', 'add'));

    expect(target.ws.frames.map((frame) => frame.type)).toEqual(['snapshot']);
    expect([...target.socket.desynced]).toEqual([]);
  });
});
