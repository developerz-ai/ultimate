// A reconnect is announced only once the server HOLDS the re-sent subscriptions. A listener told
// "the bus is back" re-reads what it missed and then trusts the subscription for everything after:
// a change published from another connection the instant it is told was lost while the server had
// not yet read the SUB. Both ways back are driven: the library's reconnect, and our re-dial.
//
//   TEST_NATS_URL=nats://localhost:4222 bun test ./packages/realtime/src/nats-transport-announce.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { parseNatsUrl } from './nats-client';
import { relayTo, throughRelay } from './nats-relay-fixture';
import { NatsTransport } from './nats-transport';

const url = Bun.env['TEST_NATS_URL'];
const BUCKET = 'xlive';
/** Zero wait: the library redials once `lastConnect + wait <= Date.now()`, and the preload freezes it. */
const NO_WAIT = { base: 0, max: 0, factor: 1, jitter: 'none' } as const;

/** The preload freezes the clock, so waiting is counted in polls rather than in elapsed time. */
const waitFor = async (done: () => boolean, polls = 200): Promise<void> => {
  // real-clock: a real nats-server answers on its own time, not this process's
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(25);
};

const started: NatsTransport[] = [];
afterAll(async () => {
  for (const created of started) await created.close();
});

/** A subscriber behind a relay, and a publisher that fires the moment the subscriber is told. */
async function rig(options: { readonly maxReconnectAttempts?: number }) {
  const target = parseNatsUrl(url ?? '');
  const relay = await relayTo(target.host, target.port);
  const bus = new NatsTransport({
    url: throughRelay(url ?? '', relay.port),
    bucket: BUCKET,
    backoff: NO_WAIT,
    onError: () => undefined,
    ...options,
  });
  const publisher = new NatsTransport({ url: url ?? '', bucket: BUCKET });
  started.push(bus, publisher);
  await publisher.connect();
  const subject = `x.change.announce.${Bun.randomUUIDv7()}`;
  const seen: string[] = [];
  const sent: Promise<void>[] = [];
  await bus.subscribe(subject, (payload) => seen.push(payload));
  // The listener does what a `sync` node's does: re-reads, then expects the bus to carry the rest.
  // A peer's change landing right then is the one published here, from another connection.
  bus.onReconnect(() => {
    sent.push(publisher.publish(subject, `at-announce-${String(sent.length + 1)}`));
  });
  return { relay, bus, seen, sent, target };
}

describe.skipIf(url === undefined)(
  'NatsTransport announces a reconnect once it is subscribed',
  () => {
    test('a change published the instant a RE-DIAL is announced is delivered', async () => {
      const it = await rig({ maxReconnectAttempts: 1 });
      let restarted: { stop(): void } | undefined;
      try {
        it.relay.stop();
        await waitFor(() => !it.bus.connected);
        restarted = await relayTo(it.target.host, it.target.port, it.relay.port);
        await waitFor(() => it.sent.length > 0);
        await Promise.all(it.sent);
        await waitFor(() => it.seen.length >= it.sent.length);

        expect(it.sent.length).toBeGreaterThan(0);
        expect(it.seen).toEqual(it.sent.map((_, at) => `at-announce-${String(at + 1)}`));
      } finally {
        await it.bus.close();
        restarted?.stop();
      }
    }, 30_000);

    test("a change published the instant the LIBRARY's reconnect is announced is delivered", async () => {
      const it = await rig({});
      try {
        it.relay.cut();
        await waitFor(() => it.sent.length > 0);
        await Promise.all(it.sent);
        await waitFor(() => it.seen.length >= it.sent.length);

        expect(it.sent.length).toBeGreaterThan(0);
        expect(it.seen).toEqual(it.sent.map((_, at) => `at-announce-${String(at + 1)}`));
      } finally {
        await it.bus.close();
        it.relay.stop();
      }
    }, 30_000);
  },
);
