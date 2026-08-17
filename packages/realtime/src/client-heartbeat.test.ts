// The heartbeat: the client had none, so a subscribed client was swept out of every presence room
// within one TTL while still receiving on the topic, and a half-open socket — one that fires no
// `onClose` because nothing ever closed it — was never detected at all. Both are driven here with
// an injected scheduler and a frozen clock; nothing sleeps.

import { describe, expect, test } from 'bun:test';
import { topic } from './channel';
import { decodeSid, feed, harness } from './client-harness-fixture';
import { DEFAULT_HEARTBEAT_MS } from './client-heartbeat';
import type { Row } from './json';
import { PROTOCOL_VERSION } from './sync-protocol';

const beating = (): ReturnType<typeof harness> => harness({ heartbeatMs: DEFAULT_HEARTBEAT_MS });

describe('the client heartbeat', () => {
  test('a live socket re-announces itself on the interval, and arms the next one', () => {
    const { client, timers, sockets } = beating();
    client.connect();
    sockets[0]?.open();
    client.subscribe(topic('org', 'o1', 'cursors'), () => {});
    expect(timers.pending).toBe(DEFAULT_HEARTBEAT_MS);

    timers.fire();

    // Re-subscribing IS the node's presence heartbeat, and the `hello` is what a socket with no
    // topics at all still gets an answer to.
    expect(sockets[0]?.frames().map((frame) => frame.type)).toEqual([
      'hello',
      'subscribe',
      'hello',
      'subscribe',
    ]);
    expect(timers.pending).toBe(DEFAULT_HEARTBEAT_MS);
  });

  /**
   * The whole reconnect, weighed in cursors. `hello.resume` carried one copy of every registration's
   * cursor and the node discarded it — a second copy of up to 512 ids per subscription, sent during
   * exactly the restart storm the heartbeat's empty beat was written to keep small. The count is the
   * assertion because both failures are payload failures: re-introducing the field reads as 2, and a
   * `subscribe` that stopped carrying the cursor reads as 0 and silently re-snapshots every client.
   */
  test('a reconnect ships each cursor exactly once, and a beat ships none', () => {
    const { client, timers, sockets } = beating();
    client.connect();
    sockets[0]?.open();
    client.useLive<Row>(feed, { orgId: 'o1' });
    sockets[0]?.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: decodeSid(sockets[0]),
      rows: [{ id: 'p1' }],
      cursor: {
        qid: 'feed',
        lsn: '1',
        digest: 'sentinel-digest',
        ids: ['p1'],
        count: 1,
        at: 1_000,
      },
    });

    sockets[0]?.close(1006);
    timers.fire(); // the reconnect
    sockets[1]?.open();
    const onOpen = [...(sockets[1]?.sent ?? [])];
    timers.fire(); // the first beat on the new socket
    const afterBeat = (sockets[1]?.sent ?? []).slice(onOpen.length);

    const carrying = (raw: readonly string[]): readonly string[] =>
      raw.filter((frame) => frame.includes('sentinel-digest'));
    // Exactly one frame on the wire holds this cursor, and it is the one that decides the resume.
    expect(carrying(onOpen)).toHaveLength(1);
    expect(carrying(onOpen)[0]).toContain('"type":"subscribe"');
    // A beat resumes nothing and asks for nothing: it says "I am here" and nothing else.
    expect(carrying(afterBeat)).toEqual([]);
    expect((sockets[1]?.frames() ?? []).filter((frame) => frame.type === 'hello')).toHaveLength(2);
  });

  test('a socket that has answered nothing for two windows is dropped and redialled', () => {
    const { client, timers, sockets, clock } = beating();
    client.connect();
    sockets[0]?.open();
    const handle = client.useLive<Row>(feed, { orgId: 'o1' });

    clock.advance(DEFAULT_HEARTBEAT_MS * 2 + 1);
    timers.fire();

    // Nothing else would ever have ended this socket: a half-open connection fires no `onClose`.
    expect(sockets[0]?.closes).toEqual([{ code: 4000, reason: 'heartbeat timeout' }]);
    expect(client.connected).toBe(false);
    expect(handle.state()).toBe('offline');
    expect(timers.pending).toBe(500); // …and the reconnect chain is armed

    timers.fire();
    expect(sockets).toHaveLength(2);
  });

  test('a frame arriving resets the silence window', () => {
    const { client, timers, sockets, clock } = beating();
    client.connect();
    sockets[0]?.open();

    clock.advance(DEFAULT_HEARTBEAT_MS * 2 + 1);
    sockets[0]?.deliver({ type: 'update-available', v: PROTOCOL_VERSION, buildId: 'build-2' });
    timers.fire();

    expect(sockets[0]?.closes).toEqual([]);
    expect(client.connected).toBe(true);
    expect(timers.pending).toBe(DEFAULT_HEARTBEAT_MS);
  });

  test('a closed socket stops beating, so the reconnect owns the only armed timer', () => {
    const { client, timers, sockets } = beating();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.close(1006);

    expect(timers.pending).toBe(500);
    expect(timers.delays).toEqual([DEFAULT_HEARTBEAT_MS, 500]);
    timers.fire();
    expect(sockets).toHaveLength(2);
  });

  test('close() stops it too — a client whose owner is gone beats at nothing', () => {
    const { client, timers, sockets } = beating();
    client.connect();
    sockets[0]?.open();

    client.close();

    expect(timers.pending).toBeNull();
  });

  test('heartbeatMs 0 arms nothing at all', () => {
    const { client, timers, sockets } = harness({ heartbeatMs: 0 });
    client.connect();
    sockets[0]?.open();

    expect(timers.pending).toBeNull();
    expect(timers.delays).toEqual([]);
  });
});
