// The socket lifecycle around `client.ts`: which close speaks for which socket, that a replaced
// socket can neither end the live connection nor apply a frame to it, that a write to a dead
// socket is a no-op rather than a throw, and that every handle a subscription hands back tears
// down exactly once. The reconnect timer is `client-reconnect.test.ts`.

import { describe, expect, test } from 'bun:test';
import { decodeSid, feed, harness } from './client-harness-fixture';
import type { Row } from './json';
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

    stale?.close(1006); // the replaced socket's close lands late
    expect(client.connected).toBe(true); // the live connection is not the corpse's to end
    expect(handle.state()).toBe('loading'); // untouched: only the live socket's close moves it
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
      cursor: { qid: 'q', lsn: '1', digest: 'd1', ids: ['p1'], count: 1, at: 0 },
    });
    expect(handle.rows()).toEqual([{ id: 'p1', likes: 1 }]);

    // The orphan replaying the same subscription's frame used to overwrite the live one's state.
    orphan?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows: [{ id: 'p1', likes: 99 }],
      cursor: { qid: 'q', lsn: '0', digest: 'd0', ids: ['p1'], count: 1, at: 0 },
    });
    expect(handle.rows()).toEqual([{ id: 'p1', likes: 1 }]);
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
