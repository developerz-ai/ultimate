// The reconnect timer: the one behaviour of `client.ts` no other suite can reach, because
// `hooks.test.ts` drives the client but has to call `connect()` a second time by hand. Everything
// here is the timer — that only the live socket's close arms one, that it dials, that the server's
// delay survives the close it triggers, that a refused dial is reported rather than thrown out of
// a timer nobody awaits, and that `close()` cancels it. The scheduler is injected, so nothing sleeps.

import { describe, expect, test } from 'bun:test';
import { feed, harness } from './client-harness-fixture';
import type { Row } from './json';
import { PROTOCOL_VERSION } from './sync-protocol';

describe('LiveClient reconnect', () => {
  test('a dropped socket arms a timer that actually dials again', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    expect(client.connected).toBe(true);

    sockets[0]?.close(1006);
    expect(client.connected).toBe(false);
    expect(sockets).toHaveLength(1); // nothing dials synchronously — the delay is the whole point
    expect(timers.pending).toBe(500);

    timers.fire();
    expect(sockets).toHaveLength(2); // the timer called connect(), which is the bug this closes
    sockets[1]?.open();
    expect(client.connected).toBe(true);
  });

  test('reconnectAt is the armed delay, and clears once the socket is back', () => {
    const { client, timers, sockets, clock } = harness();
    client.connect();
    sockets[0]?.open();
    expect(client.reconnectAt()).toBeNull();

    sockets[0]?.close(1006);
    expect(client.reconnectAt()).toBe(clock.now().getTime() + 500);

    timers.fire();
    // Still set while dialling: a countdown that blinks to null mid-attempt reads as "connected".
    expect(client.reconnectAt()).toBe(1_500);
    sockets[1]?.open();
    expect(client.reconnectAt()).toBeNull();
  });

  test('successive failures back off, and a successful open resets the curve', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.close(1006);
    timers.fire();
    sockets[1]?.close(1006); // dialled, never opened
    timers.fire();
    sockets[2]?.close(1006);
    expect(timers.delays).toEqual([500, 1000, 2000]);

    timers.fire();
    sockets[3]?.open(); // this one lands
    sockets[3]?.close(1006);
    expect(timers.delays.at(-1)).toBe(500); // attempt counter reset on open
  });

  test('the whole subscription set is re-established on the automatic reconnect', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.useLive<Row>(feed, { orgId: 'o1' });

    sockets[0]?.close(1006);
    timers.fire();
    sockets[1]?.open();

    const kinds = sockets[1]?.frames().map((frame) => frame.type) ?? [];
    expect(kinds).toEqual(['hello', 'subscribe']);
  });

  test('a server-assigned delay survives the close it triggers', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.deliver({
      type: 'reconnect',
      v: PROTOCOL_VERSION,
      afterMs: 7_777,
      reason: 'drain',
    });

    // The close the frame triggers must not overwrite the node's spread slot with a local backoff.
    expect(timers.delays).toEqual([7_777]);
    expect(timers.pending).toBe(7_777);
    expect(sockets[0]?.closes).toEqual([{ code: 1001, reason: 'drain' }]);
  });

  test('a close never stacks a second timer on top of an armed one', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.close(1006);
    sockets[0]?.close(1006); // a socket that reports its close twice
    expect(timers.delays).toEqual([500]);

    timers.fire();
    expect(sockets).toHaveLength(2);
  });

  test('a dial that throws is reported, not rethrown, and the next attempt is armed', () => {
    const { client, timers, sockets, errors, failNextDials } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.close(1006);

    failNextDials(1);
    // Nothing awaits a timer: a throw out of one is `window.onerror` in a tab and an uncaught
    // exception under Bun — the retry killing the process that was going to run it.
    expect(() => timers.fire()).not.toThrow();
    expect(errors).toHaveLength(1); // reported through the seam instead
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(String(errors[0])).toBe('TypeError: socket refused');
    expect(sockets).toHaveLength(1); // the dial produced nothing…
    expect(timers.pending).toBe(1000); // …and the chain is still armed, one attempt further on

    timers.fire();
    sockets[1]?.open();
    expect(client.connected).toBe(true);
  });

  test('a connect() the caller made itself arms nothing when it throws', () => {
    const { client, timers, errors, failNextDials } = harness();
    failNextDials(1);

    // The timer owns the chain; a direct call is the app's, and swallowing it here would retry
    // behind the back of a caller who is holding the error — so it is never reported either.
    expect(() => client.connect()).toThrow('socket refused');
    expect(timers.pending).toBeNull();
    expect(errors).toEqual([]);
  });

  test('an explicit connect() cancels the pending reconnect instead of racing it', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.close(1006);
    expect(timers.pending).toBe(500);

    client.connect();
    expect(timers.pending).toBeNull();
    sockets[1]?.open();
    expect(sockets).toHaveLength(2); // the cancelled timer never dialled a third
  });
});
