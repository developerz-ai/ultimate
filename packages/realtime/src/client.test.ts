// The socket lifecycle around `client.ts`: which close speaks for which socket, that a replaced
// socket can neither end the live connection nor apply a frame to it, that a write to a dead
// socket is a no-op rather than a throw, and that every handle a subscription hands back tears
// down exactly once. The reconnect timer is `client-reconnect.test.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { Topic } from './channel';
import { LiveClient } from './client';
import { decodeSid, FakeSocket, feed, harness, signal } from './client-harness-fixture';
import type { Row } from './json';
import { OfflineQueue, type QueueState, type QueueStore } from './offline-queue';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

describe('LiveClient close events', () => {
  test("the live socket's own close goes offline and arms a reconnect", () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });

    sockets[0]?.close(1006);
    expect(client.connected).toBe(false);
    expect(handle.state()).toBe('offline');
    expect(timers.pending).toBe(500);
  });

  test('a close from a socket the client already replaced changes nothing', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });

    const stale = sockets[0];
    client.connect(); // e.g. a forced redial after an auth refresh
    sockets[1]?.open();
    // Live again on the new socket — the state the corpse must not be able to take away. The
    // redial itself DID report offline, which is the connection it replaced being written off.
    sockets[1]?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: decodeSid(sockets[1]),
      rows: [{ id: 'p1' }],
      cursor: { qid: 'q', lsn: '1', ids: ['p1'], at: 0 },
    });
    expect(handle.state()).toBe('live');

    stale?.close(1006); // the replaced socket's close lands late
    expect(client.connected).toBe(true); // the live connection is not the corpse's to end
    expect(handle.state()).toBe('live'); // untouched: only the live socket's close moves it
    expect(timers.pending).toBeNull(); // a backoff here dials a third socket behind a healthy one
    expect(timers.delays).toEqual([]);
  });

  // A remount calling `connect()` on a live client left the previous socket open: its `onMessage`
  // kept running, so every patch frame applied twice, and the node held two sockets for one
  // client — double presence membership and double fanout — until the tab closed.
  test('closes the socket it is replacing, so nothing keeps two live', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    client.connect();

    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: 'reconnect' }]);
    expect(sockets).toHaveLength(2);
  });

  test('a frame from the replaced socket is not applied a second time', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    const orphan = sockets[0];

    client.connect();
    sockets[1]?.open();
    const sid = decodeSid(sockets[1]);
    sockets[1]?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows: [{ id: 'p1', likes: 1 }],
      cursor: { qid: 'q', lsn: '1', ids: ['p1'], at: 0 },
    });
    expect(handle.rows()).toEqual([{ id: 'p1', likes: 1 }]);

    // The orphan replaying the same subscription's frame used to overwrite the live one's state.
    orphan?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows: [{ id: 'p1', likes: 99 }],
      cursor: { qid: 'q', lsn: '0', ids: ['p1'], at: 0 },
    });
    expect(handle.rows()).toEqual([{ id: 'p1', likes: 1 }]);
  });
});

describe('LiveClient.connect failures', () => {
  // The dial is app code (`new WebSocket(url)`), so it may refuse. It threw out of `connect()`
  // with `#socket` already nulled and `#connected` still true: a client that reports itself online
  // forever, with no socket, no timer, and every mutation marked delivered into nothing.
  test('a dial that throws on a live client leaves it offline, not falsely online', () => {
    const { client, sockets, failNextDials } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    expect(client.connected).toBe(true);

    failNextDials(1);
    expect(() => client.connect()).toThrow('socket refused');

    expect(client.connected).toBe(false);
    expect(handle.state()).toBe('offline');
  });

  // The window between `connect()` and the new socket opening reported `connected === true` off
  // the socket that had just been replaced, so a `useLive` in that window sent its subscribe frame
  // ahead of `hello` — and then `onOpen` replayed the same sid, which the node refuses with
  // X_SUBSCRIPTION_ID_TAKEN.
  test('a redial is offline until the new socket opens, so no sid is subscribed twice', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    client.connect();
    expect(client.connected).toBe(false);
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    expect(handle.state()).toBe('offline');
    expect(sockets[1]?.frames()).toEqual([]);

    sockets[1]?.open();
    const frames = sockets[1]?.frames() ?? [];
    expect(frames.map((frame) => frame.type)).toEqual(['hello', 'subscribe']);
    const sids = frames.filter((frame) => frame.type === 'subscribe').map((frame) => frame.sid);
    expect(new Set(sids).size).toBe(sids.length);
  });

  // 'loading' is a promise that rows are on their way. With no socket, nothing is on its way, and
  // a spinner that never resolves is the state a component renders for the whole session.
  test('a subscription opened before the first dial reads offline, not loading', () => {
    const { client } = harness();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    expect(handle.state()).toBe('offline');
  });

  test('an open from a socket the client already replaced re-subscribes nothing', () => {
    const { client, sockets } = harness();
    client.connect();
    const stale = sockets[0];
    client.useLive<Row>(feed, { orgId: 'o1' });

    client.connect();
    sockets[1]?.open();
    const live = sockets[1]?.sent.length ?? 0;

    stale?.open(); // the replaced socket connects late
    expect(stale?.sent).toEqual([]); // …and speaks for nobody
    expect(sockets[1]?.sent).toHaveLength(live);
    expect(client.connected).toBe(true);
  });
});

describe('LiveClient.close', () => {
  test('cancels the armed reconnect and never dials again', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.close(1006);
    expect(timers.pending).toBe(500);

    client.close();
    expect(timers.pending).toBeNull();
    expect(client.reconnectAt()).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  test('closes the live socket without the close re-arming a reconnect', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    client.close(1000, 'bye');
    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(client.connected).toBe(false);
    expect(timers.pending).toBeNull();
    expect(timers.delays).toEqual([]);
  });

  test('reports every subscription offline itself, now that the close it triggers returns', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });

    client.close();
    // `useConnection().offline` going true while a `useLive` handle still reads 'live' is one dead
    // socket told two ways.
    expect(handle.state()).toBe('offline');
    expect(client.connected).toBe(false);
  });

  test('connect() after close() starts over rather than staying dead', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.close();

    client.connect();
    sockets[1]?.open();
    expect(client.connected).toBe(true);

    sockets[1]?.close(1006);
    expect(timers.pending).toBe(500);
  });
});

describe('LiveClient dead-socket writes', () => {
  test('a frame sent after the socket closed is dropped, not written into the corpse', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    const afterSubscribe = sockets[0]?.sent.length ?? 0;

    sockets[0]?.close(1006);
    handle.unsubscribe(); // would have "sent" a drop frame nobody will ever read
    expect(sockets[0]?.sent).toHaveLength(afterSubscribe);
  });

  test('a frame sent after close() is dropped too', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    const afterSubscribe = sockets[0]?.sent.length ?? 0;

    client.close();
    handle.unsubscribe();
    expect(sockets[0]?.sent).toHaveLength(afterSubscribe);
  });
});

/**
 * `QueueStore` is OPFS or IndexedDB in a browser and both are allowed to reject — a quota, a
 * private window, a storage bucket the user evicted. The writes behind a reconnect drain and behind
 * an ack frame are awaited by nobody, so a rejection there is an unhandled one: `window.onerror` in
 * a tab, a dead process under Bun. `onError` is the seam that already exists for exactly this.
 */
class ToggleStore implements QueueStore {
  fail = false;
  #state: QueueState = { mutations: [], nextSeq: 1 };

  async load(): Promise<QueueState> {
    return this.#state;
  }

  async save(state: QueueState): Promise<void> {
    if (this.fail) throw new TypeError('quota exceeded');
    this.#state = { mutations: state.mutations.map((m) => ({ ...m })), nextSeq: state.nextSeq };
  }
}

/** One turn of the microtask queue, so a detached chain has settled before the assertion. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('LiveClient detached work', () => {
  async function queued(): Promise<{
    client: LiveClient;
    socket: FakeSocket;
    store: ToggleStore;
    errors: unknown[];
  }> {
    const errors: unknown[] = [];
    const socket = new FakeSocket();
    const store = new ToggleStore();
    const client = new LiveClient({
      signal,
      connect: () => socket,
      buildId: 'build-1',
      queue: await OfflineQueue.open(store),
      clock: frozenClock(1_000),
      scheduler: () => () => {},
      heartbeatMs: 0,
      onError: (error) => {
        errors.push(error);
      },
    });
    return { client, socket, store, errors };
  }

  test('a durable write that rejects inside the reconnect drain is reported', async () => {
    const { client, socket, store, errors } = await queued();
    await client.mutate({ name: 'likePost' }, { postId: 'p1' }); // queued offline

    store.fail = true;
    client.connect();
    socket.open(); // onOpen drains, and the drain persists
    await settled();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toBe('TypeError: quota exceeded');
  });

  // The node refuses a socket it cannot write to (`socket.ts` checks `bufferedAmount` before every
  // send); the client pushed regardless, so a burst on a slow connection queued frames the tab
  // would never write and the queue counted every one of them as delivered.
  test('a backed-up socket declines the mutation instead of adding to the pile', async () => {
    const { client, socket } = await queued();
    client.connect();
    socket.open();
    socket.bufferedAmount = 2 * 1024 * 1024;

    await client.mutate({ name: 'likePost' }, { postId: 'p1' });

    expect(socket.frames().some((frame) => frame.type === 'mutate')).toBe(false);
    const stopped = client.queue?.pending()[0];
    expect(stopped?.status).toBe('pending'); // still sendable, not lost and not inflight
    expect(stopped?.error?.code).toBe('X_TRANSPORT_UNAVAILABLE');

    socket.bufferedAmount = 0;
    await client.drain();
    expect(socket.frames().some((frame) => frame.type === 'mutate')).toBe(true);
  });

  // The whole reason the queue is durable: the socket died with the frame in it, and a `send` that
  // returned proved nothing. Before this the entry was `acked` on the way out and the reconnect
  // sent ZERO frames — the mutation was gone, with the queue reporting itself empty.
  test('a socket death re-sends the mutations it was carrying on the next connection', async () => {
    const { client, socket } = await queued();
    const mutates = (): number => socket.frames().filter((frame) => frame.type === 'mutate').length;
    client.connect();
    socket.open();
    await client.mutate({ name: 'likePost' }, { postId: 'p1' });
    expect(mutates()).toBe(1);

    socket.close(1006);
    client.connect();
    socket.open();
    await settled();

    expect(mutates()).toBe(2);
    expect(client.queue?.pending()).toHaveLength(1);
  });

  test('a durable write that rejects while settling an ack is reported', async () => {
    const { client, socket, store, errors } = await queued();
    client.connect();
    socket.open();
    await client.mutate({ name: 'likePost' }, { postId: 'p1' });
    const sent = socket.frames().find((frame) => frame.type === 'mutate');

    store.fail = true;
    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: sent?.type === 'mutate' ? sent.key : '',
      lsn: null,
      error: null,
    });
    await settled();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toBe('TypeError: quota exceeded');
  });
});

describe('Disposable subscription handles', () => {
  test('using a useLive() handle sends the drop frame on scope exit', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const before = sockets[0]?.sent.length ?? 0;

    {
      using handle = client.useLive<Row>(feed, { orgId: 'o1' });
      expect(handle.rows()).toEqual([]);
    }

    // add frame (subscribing) + drop frame (the `using` scope exiting).
    const sent = sockets[0]?.sent.slice(before) ?? [];
    expect(sent).toHaveLength(2);
    const dropFrame = decode(sent[1] ?? '') as Frame & { op?: string };
    expect(dropFrame.type).toBe('subscribe');
    expect(dropFrame.op).toBe('drop');
  });

  test('[Symbol.dispose] is the same function as unsubscribe(), not a second teardown path', () => {
    const { client } = harness();
    client.connect();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });
    expect(handle[Symbol.dispose]).toBe(handle.unsubscribe);
  });

  test('a topic subscription is still directly callable, and using it unsubscribes on scope exit', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const messages: unknown[] = [];
    const before = sockets[0]?.sent.length ?? 0;

    {
      using unsub = client.subscribe('org.o1.cursors' as Topic, (message) => {
        messages.push(message);
      });
      expect(typeof unsub).toBe('function');
    }

    const sent = sockets[0]?.sent.slice(before) ?? [];
    // add frame (subscribing) + drop frame (the `using` scope exiting).
    expect(sent).toHaveLength(2);
    const dropFrame = decode(sent[1] ?? '') as Frame & { op?: string };
    expect(dropFrame.type).toBe('subscribe');
    expect(dropFrame.op).toBe('drop');
  });

  test('a topic Unsubscribe is directly callable as [Symbol.dispose]', () => {
    const { client } = harness();
    client.connect();
    const unsub = client.subscribe('org.o1.cursors' as Topic, () => {});
    expect(unsub[Symbol.dispose]).toBe(unsub);
  });
});
