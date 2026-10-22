// The two ways a redial loses time: a socket that opens and is dropped before the node says a
// word (a proxy, an overloaded node) resetting the backoff, and a tab that came back online or
// visible sitting out a wait armed while it was gone. `wake()` is the second's cure.

import { describe, expect, test } from 'bun:test';
import { harness } from './client-harness-fixture';
import { PROTOCOL_VERSION } from './sync-protocol';

describe('LiveClient backoff reset and wake', () => {
  test('a socket that opens and drops before any frame keeps backing off', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.disconnect();
    for (let dial = 1; dial <= 3; dial++) {
      timers.fire();
      sockets[dial]?.open(); // accepted, then dropped with no word from the node
      sockets[dial]?.disconnect();
    }
    expect(timers.delays).toEqual([500, 1000, 2000, 4000]);
  });

  test('wake() dials at once instead of sitting out a local backoff, and restarts the curve', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.disconnect();
    timers.fire();
    sockets[1]?.disconnect();
    expect(timers.pending).toBe(1000);

    client.wake();
    expect(sockets).toHaveLength(3);
    expect(timers.pending).toBeNull();
    sockets[2]?.disconnect();
    expect(timers.delays.at(-1)).toBe(500);
  });

  test('wake() keeps a node-assigned drain slot, so a deploy herd stays spread', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.deliver({
      type: 'reconnect',
      v: PROTOCOL_VERSION,
      afterMs: 7_777,
      reason: 'drain',
    });

    client.wake();
    expect(sockets).toHaveLength(1);
    expect(timers.pending).toBe(7_777);
  });

  test('wake() is a no-op while connected, and after close()', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.wake();
    expect(sockets).toHaveLength(1);

    client.close();
    client.wake();
    expect(sockets).toHaveLength(1);
    expect(timers.pending).toBeNull();
  });
});
