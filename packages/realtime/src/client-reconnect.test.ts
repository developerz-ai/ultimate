// The reconnect timer: the one behaviour of `client.ts` no other suite can reach, because
// `hooks.test.ts` drives the client but has to call `connect()` a second time by hand. Everything
// here is the timer — that only the live socket's close arms one, that it dials, that the server's
// delay survives the close it triggers, that a refused dial is reported rather than thrown out of
// a timer nobody awaits, and that `close()` cancels it. The scheduler is injected, so nothing sleeps.

import { describe, expect, test } from 'bun:test';
import { LiveClient } from './client';
import { RECONNECT_CODE } from './client-frames';
import {
  backoff,
  cursorsChannel,
  FakeSocket,
  feed,
  harness,
  ManualScheduler,
} from './client-harness-fixture';
import type { JsonObject, Row } from './json';
import { PROTOCOL_VERSION } from './sync-protocol';
import { BROWSER_RECONNECT_MAX_MS } from './thundering-herd';

describe('LiveClient reconnect', () => {
  test('a dropped socket arms a timer that actually dials again', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    expect(client.connected).toBe(true);

    sockets[0]?.disconnect();
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

    sockets[0]?.disconnect();
    expect(client.reconnectAt()).toBe(clock.now().getTime() + 500);

    timers.fire();
    // Still set while dialling: a countdown that blinks to null mid-attempt reads as "connected".
    expect(client.reconnectAt()).toBe(1_500);
    sockets[1]?.open();
    expect(client.reconnectAt()).toBeNull();
  });

  // The page's own retry re-opens its virtual socket on this curve, so a 30s cap here held a tab
  // off a node that was already back — measured after a deploy, 27s with no dial at all.
  test('with no policy given, the wait is capped at seconds, whatever the attempt', () => {
    const { client, timers, sockets } = harness({ backoff: 'client-default', rng: () => 1 });
    client.connect();
    sockets[0]?.open();
    sockets[0]?.disconnect();
    for (let failure = 1; failure < 20; failure++) {
      timers.fire();
      sockets[failure]?.disconnect();
    }
    expect(Math.max(...timers.delays)).toBeLessThanOrEqual(BROWSER_RECONNECT_MAX_MS);
  });

  test('successive failures back off, and a successful open resets the curve', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.disconnect();
    timers.fire();
    sockets[1]?.disconnect(); // dialled, never opened
    timers.fire();
    sockets[2]?.disconnect();
    expect(timers.delays).toEqual([500, 1000, 2000]);

    timers.fire();
    sockets[3]?.open(); // this one lands
    sockets[3]?.disconnect();
    expect(timers.delays.at(-1)).toBe(500); // attempt counter reset on open
  });

  test('the whole subscription set is re-established on the automatic reconnect', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.subscribeLive<Row>(feed, { orgId: 'o1' });

    sockets[0]?.disconnect();
    timers.fire();
    sockets[1]?.open();

    const kinds = sockets[1]?.frames().map((frame) => frame.type) ?? [];
    expect(kinds).toEqual(['hello', 'subscribe']);
  });

  // Topic membership lives on the node's socket and the `hello` frame carries none of it, so a
  // handler this client still holds is a channel that went silent at the first reconnect — with
  // `useConnection().online` true and no error anywhere. Presence goes with it: subscribing IS
  // joining the room, so a subscription never re-sent is a member the sweep removes.
  test('channel subscriptions are re-established too, not just the live queries', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.subscribeLive<Row>(feed, { orgId: 'o1' });
    const seen: JsonObject[] = [];
    client.holdChannel(cursorsChannel, { orgId: 'o1' }, { onEvent: (event) => seen.push(event) });

    sockets[0]?.disconnect();
    timers.fire();
    sockets[1]?.open();

    const kinds = sockets[1]?.frames().map((frame) => frame.type) ?? [];
    expect(kinds).toEqual(['hello', 'subscribe', 'subscribe']);
    const channels = (sockets[1]?.frames() ?? []).filter(
      (frame) => frame.type === 'subscribe' && frame.target.kind === 'channel',
    );
    expect(channels).toHaveLength(1);

    // And the handler is actually reachable on the new socket, which is what the app sees.
    sockets[1]?.deliver({
      type: 'events',
      v: PROTOCOL_VERSION,
      channel: 'org-cursors.o1',
      event: { at: 4 },
    });
    expect(seen).toEqual([{ at: 4 }]);
  });

  test('a released channel is not resurrected by the reconnect', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();
    client.holdChannel(cursorsChannel, { orgId: 'o1' }).release();

    sockets[0]?.disconnect();
    timers.fire();
    sockets[1]?.open();

    expect(sockets[1]?.frames().map((frame) => frame.type)).toEqual(['hello']);
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
    expect(sockets[0]?.closes).toEqual([{ code: RECONNECT_CODE, reason: 'drain' }]);
  });

  // The frame closed with 1001, and a browser refuses that from script: `WebSocket.close()`
  // throws `InvalidAccessError: The close code must be either 1000, or between 3000 and 4999` —
  // measured in Chrome, an uncaught exception in every tab on every node drain. The reconnect
  // still happened, because the node closed the socket itself a moment later; the exception was
  // the only trace, and it was in every tab.
  test('the reconnect frame closes with a code a browser accepts from script', () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.deliver({ type: 'reconnect', v: PROTOCOL_VERSION, afterMs: 100, reason: 'drain' });

    const code = sockets[0]?.closes[0]?.code ?? 0;
    expect(code === 1000 || (code >= 3000 && code <= 4999)).toBe(true);
  });

  test('a close never stacks a second timer on top of an armed one', () => {
    const { client, timers, sockets } = harness();
    client.connect();
    sockets[0]?.open();

    sockets[0]?.disconnect();
    sockets[0]?.disconnect(); // a socket that reports its close twice
    expect(timers.delays).toEqual([500]);

    timers.fire();
    expect(sockets).toHaveLength(2);
  });

  test('a dial that throws is reported, not rethrown, and the next attempt is armed', () => {
    const { client, timers, sockets, errors, failNextDials } = harness();
    client.connect();
    sockets[0]?.open();
    sockets[0]?.disconnect();

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
    sockets[0]?.disconnect();
    expect(timers.pending).toBe(500);

    client.connect();
    expect(timers.pending).toBeNull();
    sockets[1]?.open();
    expect(sockets).toHaveLength(2); // the cancelled timer never dialled a third
  });
});

describe('LiveClient channel catch-up retry', () => {
  // The book counts failures from 1 and core counts waits from 1, so the first retry waits the
  // base. Shifting the count once more — which the 0-based realtime copy did — waited 1_000 here.
  test('a failed catch-up waits the base before its first retry, on core counting', async () => {
    const timers = new ManualScheduler();
    const socket = new FakeSocket();
    const client = new LiveClient({
      connect: () => socket,
      buildId: 'build-1',
      catchUp: async () => {
        throw new TypeError('network down');
      },
      heartbeatMs: 0,
      backoff,
      scheduler: timers.schedule,
      onError: () => undefined,
    });
    client.connect();
    socket.open();
    client.holdChannel(cursorsChannel, { orgId: 'o1' });
    socket.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: 'org-cursors.o1',
      epoch: 'e1',
    });
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(timers.pending).toBe(backoff.baseMs);
    client.close();
  });
});
