// The socket lifecycle around `client.ts`: which close speaks for which socket, that a replaced
// socket can neither end the live connection nor apply a frame to it, that a write to a dead
// socket is a no-op rather than a throw, and that every handle a subscription hands back tears
// down exactly once. The reconnect timer is `client-reconnect.test.ts`.

import { describe, expect, test } from 'bun:test';
import { LiveClient } from './client';
import {
  cursorsChannel,
  decodeSid,
  FakeSocket,
  feed,
  harness,
  ManualScheduler,
} from './client-harness-fixture';
import type { Row } from './json';
import { decode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

describe('LiveClient close events', () => {
  test("the live socket's own close goes offline and arms a reconnect", () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });

    sockets[0]?.disconnect();
    expect(client.connected).toBe(false);
    expect(handle.state()).toBe('offline');
    expect(timers.pending).toBe(500);
  });

  test('a close from a socket the client already replaced changes nothing', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });

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

    stale?.disconnect(); // the replaced socket's close lands late
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
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
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
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
    expect(client.connected).toBe(true);

    failNextDials(1);
    expect(() => client.connect()).toThrow('socket refused');

    expect(client.connected).toBe(false);
    expect(handle.state()).toBe('offline');
  });

  // The window between `connect()` and the new socket opening reported `connected === true` off
  // the socket that had just been replaced, so a subscription opened in that window sent its subscribe frame
  // ahead of `hello` — and then `onOpen` replayed the same sid, which the node refuses with
  // X_SUBSCRIPTION_ID_TAKEN.
  test('a redial is offline until the new socket opens, so no sid is subscribed twice', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    client.connect();
    expect(client.connected).toBe(false);
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
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
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
    expect(handle.state()).toBe('offline');
  });

  test('an open from a socket the client already replaced re-subscribes nothing', () => {
    const { client, sockets } = harness();
    client.connect();
    const stale = sockets[0];
    client.subscribeLive<Row>(feed, { orgId: 'o1' });

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
    sockets[0]?.disconnect();
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
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });

    client.close();
    // `useConnection().offline` going true while a live handle still reads 'live' is one dead
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

    sockets[1]?.disconnect();
    expect(timers.pending).toBe(500);
  });
});

describe('LiveClient dead-socket writes', () => {
  test('a frame sent after the socket closed is dropped, not written into the corpse', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
    const afterSubscribe = sockets[0]?.sent.length ?? 0;

    sockets[0]?.disconnect();
    handle.unsubscribe(); // would have "sent" a drop frame nobody will ever read
    expect(sockets[0]?.sent).toHaveLength(afterSubscribe);
  });

  test('a frame sent after close() is dropped too', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
    const afterSubscribe = sockets[0]?.sent.length ?? 0;

    client.close();
    handle.unsubscribe();
    expect(sockets[0]?.sent).toHaveLength(afterSubscribe);
  });
});

describe('Disposable subscription handles', () => {
  test('using a subscribeLive() handle sends the drop frame on scope exit', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const before = sockets[0]?.sent.length ?? 0;

    {
      using handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
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
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
    expect(handle[Symbol.dispose]).toBe(handle.unsubscribe);
  });

  test('a channel membership is Disposable, and using it drops on scope exit', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const before = sockets[0]?.sent.length ?? 0;

    {
      using membership = client.holdChannel(cursorsChannel, { orgId: 'o1' });
      expect(membership[Symbol.dispose]).toBe(membership.release);
    }

    const sent = sockets[0]?.sent.slice(before) ?? [];
    // add frame (holding) + drop frame (the `using` scope exiting).
    expect(sent).toHaveLength(2);
    const dropFrame = decode(sent[1] ?? '') as Frame & { op?: string };
    expect(dropFrame.type).toBe('subscribe');
    expect(dropFrame.op).toBe('drop');
  });
});

describe('LiveClient listeners and its default reporter', () => {
  test('an onChange or onStatus listener that was removed hears nothing more', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    const handle = client.subscribeLive<Row>(feed, { orgId: 'o1' });
    let changes = 0;
    let statuses = 0;
    const offChange = handle.onChange(() => {
      changes += 1;
    });
    const offStatus = client.onStatus(() => {
      statuses += 1;
    });
    offChange();
    offStatus();
    sockets[0]?.disconnect();
    expect(handle.state()).toBe('offline');
    expect(changes).toBe(0);
    expect(statuses).toBe(0);
  });

  test('with no onError, a failure nothing awaits goes to console.error — never thrown', () => {
    const timers = new ManualScheduler();
    let dials = 0;
    const socket = new FakeSocket();
    const client = new LiveClient({
      connect: () => {
        dials += 1;
        if (dials > 1) throw new TypeError('socket refused');
        return socket;
      },
      buildId: 'build-1',
      catchUp: async () => undefined,
      heartbeatMs: 0,
      scheduler: timers.schedule,
    });
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      client.connect();
      socket.open();
      socket.disconnect();
      expect(() => timers.fire()).not.toThrow();
    } finally {
      console.error = original;
      client.close();
    }
    expect(String(logged[0])).toBe('TypeError: socket refused');
  });
});
