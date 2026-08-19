// The node's inbound surface under the only condition it actually runs in: several frames from one
// socket in flight at once. `sync-node` dispatches every frame as `void (async () => …)()`, so
// nothing upstream orders them — two mutations from one client could reach the database in the
// reverse of the order that client sent them, and a subscribe/drop pair for one sid could strand
// the subscription it was meant to end.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import type { Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { CLOSE, SocketRegistry, SyncSocket, type WsLike } from './socket';
import { ackRefOf, createFrameRouter, type MutationHandler } from './sync-frames';
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
    onMutate?: MutationHandler;
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
    ...(options.onMutate ? { onMutate: options.onMutate } : {}),
  });
  return { socket, ws, registry, route: (frame) => route(socket, frame) };
}

const mutate = (key: string, seq: number): Frame => ({
  type: 'mutate',
  v: PROTOCOL_VERSION,
  key,
  seq,
  name: 'likePost',
  input: { postId: 'p1' },
});

const subscribeQuery = (sid: string, op: 'add' | 'drop'): Frame => ({
  type: 'subscribe',
  v: PROTOCOL_VERSION,
  op,
  sid,
  target: { kind: 'query', qid: 'liveFeed', input: { orgId: 'o1' }, cursor: null },
});

describe("one client's mutations reach the database in the order it sent them", () => {
  test('a slow mutation holds the ones behind it, on that socket', async () => {
    const first = deferred<{ lsn: string }>();
    const applied: string[] = [];
    const target = rig({
      onMutate: async ({ key }) => {
        if (key === 'm1') await first.promise;
        applied.push(key);
        return { lsn: formatLsn(applied.length) };
      },
    });

    // Both dispatched before either finishes — exactly what `sync-node.message` does.
    const both = Promise.all([target.route(mutate('m1', 1)), target.route(mutate('m2', 2))]);
    await flush();
    expect(applied).toEqual([]);
    first.resolve({ lsn: formatLsn(1) });
    await both;

    // `local(tx, input)` is replayed against the server's answers in this order; applied backwards,
    // the client's rebase folds an older write over a newer one and the row stays wrong.
    expect(applied).toEqual(['m1', 'm2']);
    expect(
      target.ws.frames.map((frame) => (frame.type === 'ack' ? frame.ref : frame.type)),
    ).toEqual(['m1', 'm2']);
  });

  test('a slow subscribe does NOT hold this socket’s mutations behind it', async () => {
    const read = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = rig({
      snapshot: () => read.promise,
      onMutate: async () => ({ lsn: formatLsn(1) }),
    });

    const subscribing = target.route(subscribeQuery('S', 'add'));
    const mutating = target.route(mutate('m1', 1));
    await mutating;

    // A snapshot read is a database round trip; a global per-socket lane would put every other
    // frame this client sends behind it, once per reconnect, for every query it holds.
    expect(target.ws.frames.map((frame) => frame.type)).toEqual(['ack']);
    read.resolve({ rows, lsn: formatLsn(1) });
    await subscribing;
    expect(target.ws.frames.map((frame) => frame.type)).toEqual(['ack', 'snapshot']);
  });
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

describe('what a successful mutation answers with', () => {
  // The ack is the receipt and the rebase is the state, so the receipt goes LAST: an ack retires
  // the client's record of the mutation — its journal row and its rebase-log entry — and a rebase
  // that arrives after that has no entry to read the mutator's conflict strategy off, and no
  // sequence to decide which later optimistic writes to replay over server truth.
  test('sends the rebase before the ack that retires the record it needs', async () => {
    const target = rig({
      onMutate: async () => ({
        lsn: formatLsn(1),
        entity: 'posts',
        row: { id: 'p1', orgId: 'o1' },
      }),
    });

    await target.route(mutate('m1', 1));

    expect(target.ws.frames.map((frame) => frame.type)).toEqual(['rebase', 'ack']);
  });

  test('a handler that names no entity answers with the ack alone', async () => {
    const target = rig({ onMutate: async () => ({ lsn: formatLsn(1) }) });

    await target.route(mutate('m1', 1));

    // Which is exactly why the ack has to commit on its own: for this handler nothing else ever
    // comes, and a client that waited for a rebase would hold that journal for the session.
    expect(target.ws.frames.map((frame) => frame.type)).toEqual(['ack']);
  });
});

/**
 * The heartbeat's `hello` was documented as how a client that stays up across a deploy hears about
 * it. It cannot be: skew is `clientBuildId` (readonly, recorded at the upgrade) against this node's
 * own build, and neither can change while the socket is open — so the answer is a property of the
 * socket, fixed for its whole life, and a beat can only ever hear what the first `hello` heard. A
 * client learns about a deploy on the socket it opens against the *new* node.
 */
describe('what a hello answers is fixed when the socket is accepted', () => {
  const helloFrame: Frame = {
    type: 'hello',
    v: PROTOCOL_VERSION,
    buildId: 'whatever-the-client-says',
    sessionId: null,
    actorId: null,
  };

  function nodeOf(
    clientBuildId: string,
    serverBuildId: string,
  ): { ws: FakeWs; beat: () => Promise<void> } {
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
    return { ws, beat: () => route(socket, helloFrame) };
  }

  test('an up-to-date socket is never told about an update, however long it beats', async () => {
    const { ws, beat } = nodeOf('build-1', 'build-1');

    for (let i = 0; i < 3; i += 1) await beat();

    // Three beats, three plain hellos. Nothing here can turn into an `update-available` later:
    // the frame's own `buildId` is not read, and both ids the answer derives from are readonly.
    expect(ws.frames.map((frame) => frame.type)).toEqual(['hello', 'hello', 'hello']);
  });

  test('a skewed socket is told on every hello, because the first one already knew', async () => {
    const { ws, beat } = nodeOf('build-1', 'build-2');

    await beat();
    await beat();

    expect(ws.frames.map((frame) => frame.type)).toEqual([
      'hello',
      'update-available',
      'hello',
      'update-available',
    ]);
  });
});

describe('ackRefOf', () => {
  test('names the mutation key, which is the only thing the client can look one up by', () => {
    expect(ackRefOf(mutate('m1', 1), 'sock-1')).toBe('m1');
  });

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
 * `send` answers `false` when backpressure dropped the frame, and this file's four sends threw that
 * answer away. The subscription is the repairable one and the one that was silently wrong: the
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

  test('a settlement the socket refuses closes it, so the client requeues and replays', async () => {
    const target = rig({ buffered: 4_096, onMutate: async () => ({ lsn: formatLsn(1) }) });

    await target.route(mutate('m1', 1));

    // Nothing on the node holds a mutation after `onMutate` returns, and a client only hands an
    // `inflight` mutation back to its queue when the connection dies. Left open, that write is
    // never retired and never retried, with the server believing it settled.
    expect(target.ws.frames).toHaveLength(0);
    expect(target.ws.closes).toEqual([[CLOSE.overloaded, 'settlement undeliverable']]);
  });

  test('a dropped rebase is never followed by the ack that would retire it', async () => {
    const target = rig({
      buffered: 4_096,
      onMutate: async () => ({ lsn: formatLsn(1), entity: 'posts', row: { id: 'p1' } }),
    });

    await target.route(mutate('m1', 1));

    // The ack retires the client's rebase-log entry. Acking a rebase that never left is the same
    // divergence the rebase-before-ack order exists to prevent, one frame later.
    expect(target.ws.closes).toHaveLength(1);
  });
});
