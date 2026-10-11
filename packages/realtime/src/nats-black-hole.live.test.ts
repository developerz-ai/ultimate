// A nats-server that ACCEPTS the socket and then says nothing: no reset, no FIN, no byte. A cut
// connection announces itself; this one only a ping can notice. The client pings every
// `PING_INTERVAL_MS` and gives up on the connection after `MAX_PINGS_OUT` unanswered — about half
// a minute — and what is proven here is that window, measured against a real server through a
// relay that stops forwarding, for both kinds of process:
//
//  - a PUBLISHER, whose publishes go into the void until detection and are refused at once after;
//  - a `sync` NODE with a page seated on it, whose beat is answered with the coded refusal — the
//    membership reads `joining`, never the terminal `failed` — and is `live` again, on the same
//    socket, once the bus is back.
//
// Skips unless a JetStream-enabled server is configured. Slow by construction — the window is the
// subject — so both processes sit behind ONE relay and wait out one window, in one test:
//
//   TEST_NATS_URL=nats://localhost:4222 bun test packages/realtime/src/nats-black-hole.live.test.ts

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, isUltimateError, logger } from '@ultimat3/core';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import { parseNatsUrl } from './nats-client';
import { MAX_PINGS_OUT, PING_INTERVAL_MS } from './nats-lib-client';
import { relayTo, throughRelay } from './nats-relay-fixture';
import { NatsTransport } from './nats-transport';
import { OPEN_POLICY } from './policy-fake-fixture';
import { outageRig, waitFor } from './sync-outage-rig-fixture';

const url = Bun.env['TEST_NATS_URL'];
const BUCKET = 'xblackhole';
/** Zero wait: the library redials once `lastConnect + wait <= Date.now()`, and the preload freezes it. */
const NO_WAIT = { baseMs: 0, maxMs: 0, factor: 1, jitter: 'none' } as const;

/** The configured window: every ping interval up to and including the one that gives up. */
const DETECTION_MS = PING_INTERVAL_MS * (MAX_PINGS_OUT + 1);
/** One more interval of grace for the timer the window is counted on, never a second window. */
const DETECTION_CEILING_MS = DETECTION_MS + PING_INTERVAL_MS;

const room = channel('black-hole-room', {
  params: ['orgId'],
  catchUp: { name: 'blackHoleRead' },
  policy: OPEN_POLICY,
  events: true,
});

afterAll(() => {
  clearChannels();
});

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Wall time, from the one clock the preload leaves alone. */
const elapsedSince = (startedAt: number): number => Math.round(performance.now() - startedAt);

describe.skipIf(url === undefined)('a nats-server that goes silent under open connections', () => {
  test(
    'is detected inside the configured window; a publisher is refused at once after it, a seated page reads `joining` throughout, and both resume with no restart',
    async () => {
      const error = spyOn(logger, 'error').mockImplementation(() => undefined);
      const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
      const target = parseNatsUrl(url ?? '');
      const relay = await relayTo(target.host, target.port);
      // The preload's frozen `Date.now()` is what every other part of the node reads too.
      const clock = frozenClock(Date.now());
      /** A process that only publishes: `web`, `worker`, `scheduler`. */
      const publisher = new NatsTransport({
        url: throughRelay(url ?? '', relay.port),
        bucket: BUCKET,
        presenceBucket: 'first-use',
        backoff: NO_WAIT,
        outageLevel: 'warn',
      });
      /** A `sync` node's bus. */
      const transport = new NatsTransport({
        url: throughRelay(url ?? '', relay.port),
        bucket: BUCKET,
        backoff: NO_WAIT,
        clock,
      });
      /** Not behind the relay: the rest of the fleet, which the outage never touched. */
      const direct = new NatsTransport({ url: url ?? '', bucket: BUCKET, backoff: NO_WAIT });
      const subject = `x.change.blackhole.${Bun.randomUUIDv7()}`;
      const seen: string[] = [];
      let stop: (() => Promise<void>) | undefined;
      try {
        publisher.connectInBackground();
        await transport.connect();
        await direct.connect();
        await waitFor(() => publisher.connected, 400, 25);
        await direct.subscribe(subject, (payload) => seen.push(payload));
        await publisher.publish(subject, 'before');
        await waitFor(() => seen.length === 1, 200, 25);
        expect(seen).toEqual(['before']);
        // A refused beat is answered only when the KV request under it times out (5 s).
        const t = await outageRig({
          transport,
          publisher: direct,
          clock,
          room,
          answerPolls: 5_000,
        });
        stop = t.stop;
        await waitFor(() => t.membership.state() === 'live', 400, 25);
        expect(t.membership.state()).toBe('live');

        relay.hold();
        const heldAt = performance.now();
        const detected: { publisher?: number; node?: number } = {};
        const watching = setInterval(() => {
          if (!publisher.connected) detected.publisher ??= elapsedSince(heldAt);
          if (!transport.connected) detected.node ??= elapsedSince(heldAt);
        }, 50);

        try {
          // INSIDE the window both connections still read `up`. A publish is taken, and lost —
          // the at-most-once contract: the event said "re-read", and a reader that reconnects
          // re-reads. That is why the window is kept this short.
          expect(publisher.connected).toBe(true);
          await publisher.publish(subject, 'into the void');
          // The node's presence write under the page's beat goes unanswered, and the node says
          // so — coded, under the membership's sid — one request timeout later.
          await t.beat();
          expect(transport.connected).toBe(true);
          expect(elapsedSince(heldAt)).toBeLessThan(PING_INTERVAL_MS);
          expect(t.acks()).toEqual(['X_TRANSPORT_UNAVAILABLE']);
          expect(t.membership.state()).toBe('joining');

          await waitFor(
            () => detected.publisher !== undefined && detected.node !== undefined,
            DETECTION_CEILING_MS / 100,
            100,
          );
        } finally {
          clearInterval(watching);
        }
        // Not before the second unanswered ping, not after the window (+ one interval of grace).
        for (const after of [detected.publisher, detected.node]) {
          expect(after).toBeGreaterThanOrEqual(PING_INTERVAL_MS * MAX_PINGS_OUT - 1_000);
          expect(after).toBeLessThanOrEqual(DETECTION_CEILING_MS);
        }

        // DETECTED. The publisher is refused, typed, at once — never parked behind the reconnect.
        const refusedAt = performance.now();
        expect(codeOf(await caught(publisher.publish(subject, 'refused')))).toBe(
          'X_TRANSPORT_UNAVAILABLE',
        );
        expect(elapsedSince(refusedAt)).toBeLessThan(500);
        // The page's beat gets the same answer as before, now at once, and still never terminal.
        const beatAt = performance.now();
        await t.beat();
        expect(elapsedSince(beatAt)).toBeLessThan(1_000);
        expect(t.acks()).toEqual(['X_TRANSPORT_UNAVAILABLE', 'X_TRANSPORT_UNAVAILABLE']);
        expect(t.membership.state()).toBe('joining');
        expect(t.membership.error()).toBeUndefined();

        // LEVELS. The publisher is degraded and still serving: its outage is a warning. The
        // node cannot do its job: its own is an error.
        const outageLines = (spy: typeof error): unknown[] =>
          spy.mock.calls.filter(([message]) => message === 'nats transport error');
        expect(outageLines(warn).length).toBeGreaterThanOrEqual(1);
        expect(outageLines(error).length).toBeGreaterThanOrEqual(1);

        relay.release();
        await waitFor(() => publisher.connected && transport.connected, 800, 25);
        expect(publisher.connected).toBe(true);
        expect(transport.connected).toBe(true);
        await publisher.publish(subject, 'after');
        await waitFor(() => seen.length === 2, 200, 25);
        // The one lost in the window stays lost; nothing was queued and replayed late.
        expect(seen).toEqual(['before', 'after']);

        await t.beat();
        await waitFor(() => t.membership.state() === 'live', 400, 25);
        expect(t.membership.state()).toBe('live');
        expect((await t.presence.list(t.topic)).map((member) => member.id)).toEqual(['sock-1']);
        await t.publish({ typing: 'ana' });
        await waitFor(() => t.events.length > 0, 400, 25);
        expect(t.events).toEqual([{ typing: 'ana' }]);
        expect(t.errors).toEqual([]);
      } finally {
        error.mockRestore();
        warn.mockRestore();
        await stop?.();
        await publisher.close();
        await transport.close();
        await direct.close();
        relay.stop();
      }
    },
    DETECTION_CEILING_MS + 60_000,
  );
});
