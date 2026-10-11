// The whole path, node and client: a page seated on a `sync` node whose bus goes away and comes
// back. While it is away the node answers the page's beat with a coded `ack` and the membership
// reads `joining`; once it is back the SAME socket's next beat re-establishes the member, the
// roster is told again, events flow, and the membership reads `live` — with no reload.

import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  configureErrorReporting,
  frozenClock,
  logger,
  memoryErrorReporter,
  resetErrorReporting,
} from '@ultimat3/core';
import { ChannelHub } from './channel';
import { channel } from './channel-decl';
import { clearChannels } from './channel-registry';
import type { NatsClient, NatsClientOptions, NatsConnect } from './nats-client';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport } from './nats-transport';
import { OPEN_POLICY } from './policy-fake-fixture';
import { PresenceRegistry } from './presence';
import { SocketRegistry } from './socket';
import { busOutage, SYNC_BUS_UNAVAILABLE } from './sync-bus-outage';
import { outageRig, waitFor } from './sync-outage-rig-fixture';
import type { BackoffPolicy } from './thundering-herd';

const room = channel('outage-room', {
  params: ['orgId'],
  catchUp: { name: 'roomRead' },
  policy: OPEN_POLICY,
  events: true,
});
const NO_WAIT: BackoffPolicy = { baseMs: 0, maxMs: 0, factor: 1, jitter: 'none' };

afterAll(() => {
  clearChannels();
});

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function rig() {
  const clock = frozenClock(1_700_000_000_000);
  const broker = new FakeNatsBroker({ clock });
  const open = fakeNatsConnect(broker);
  const dialled: { readonly client: NatsClient; readonly options: NatsClientOptions }[] = [];
  const connect: NatsConnect = async (options) => {
    const client = await open(options);
    dialled.push({ client, options });
    return client;
  };
  const bus = (): NatsTransport =>
    new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      backoff: NO_WAIT,
      connect,
    });
  const transport = bus();
  await transport.connect();
  const publisher = bus();
  await publisher.connect();
  const seated = await outageRig({ transport, publisher, clock, room });
  return {
    ...seated,
    broker,
    dialled,
    stop: async (): Promise<void> => {
      await seated.stop();
      await transport.close();
      await publisher.close();
    },
  };
}

describe('a seated socket through a bus outage', () => {
  test('reads `joining` while the bus is away, and is `live` again — member, roster and events — once it returns', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = spyOn(logger, 'info').mockImplementation(() => undefined);
    spies.push(error, info);
    const t = await rig();
    try {
      await waitFor(() => t.membership.state() === 'live');
      expect(t.membership.state()).toBe('live');
      expect((await t.presence.list(t.topic)).map((m) => m.id)).toEqual(['sock-1']);

      // The bus goes away. Three beats, each answered with the coded refusal — never terminal.
      t.broker.drop();
      for (let beat = 0; beat < 3; beat += 1) {
        await t.beat();
        expect(t.membership.state()).toBe('joining');
      }
      expect(t.acks()).toEqual(Array.from({ length: 3 }, () => 'X_TRANSPORT_UNAVAILABLE'));
      expect(t.membership.error()).toBeUndefined();

      // It returns EMPTY — a restarted server kept no presence bucket — and the library reconnects.
      t.broker.forget();
      t.broker.restore();
      const rostersBefore = t.rosters.length;
      await t.beat();
      await waitFor(() => t.membership.state() === 'live');
      expect(t.membership.state()).toBe('live');
      // The member is re-established under the same socket id, and the page is told the roster.
      expect((await t.presence.list(t.topic)).map((m) => m.id)).toEqual(['sock-1']);
      expect(t.rosters.length).toBeGreaterThan(rostersBefore);
      expect(t.rosters.at(-1)?.members.map((member) => member.id)).toEqual(['sock-1']);

      // …and an event published by another process reaches the page that never reloaded.
      await t.publish({ typing: 'ana' });
      await waitFor(() => t.events.length > 0);
      expect(t.events).toEqual([{ typing: 'ana' }]);
      expect(t.acks()).toHaveLength(3);
      expect(t.errors).toEqual([]);

      // Three refused beats are ONE outage: said on the 1st and 2nd, at error — the node cannot
      // do its job — and ended by one line. The transport says its own drop once beside it.
      const said = error.mock.calls.filter(([message]) => message === SYNC_BUS_UNAVAILABLE);
      expect(said.map(([, fields]) => [fields?.['operation'], fields?.['failures']])).toEqual([
        ['sync.frame', 1],
        ['sync.frame', 2],
      ]);
      expect(error.mock.calls.map(([message]) => message).sort()).toEqual([
        'nats transport error',
        'nats transport error',
        SYNC_BUS_UNAVAILABLE,
        SYNC_BUS_UNAVAILABLE,
      ]);
      expect(
        info.mock.calls.filter(([message]) => message === `${SYNC_BUS_UNAVAILABLE} recovered`),
      ).toEqual([[`${SYNC_BUS_UNAVAILABLE} recovered`, { after: 3 }]]);
    } finally {
      await t.stop();
    }
  });

  test('…and when the library GAVE UP on the connection: re-dialled, re-bound, and `live` on the next beat', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    spies.push(error);
    const t = await rig();
    try {
      await waitFor(() => t.membership.state() === 'live');
      // The node's own connection is dial #0; the library closes it for good while the server is
      // refusing dials, so the transport's re-dial loop is what brings it back.
      t.broker.offline = true;
      const first = t.dialled[0];
      await first?.client.close();
      first?.options.onClosed?.();
      await t.beat();
      expect(t.membership.state()).toBe('joining');
      expect(t.acks()).toEqual(['X_TRANSPORT_UNAVAILABLE']);

      t.broker.forget();
      t.broker.offline = false;
      // dial #1 is the publisher's; the node's replacement is the next one to land.
      await waitFor(() => t.dialled.length >= 3);
      await t.beat();
      await waitFor(() => t.membership.state() === 'live');
      expect(t.membership.state()).toBe('live');

      await t.publish({ typing: 'ana' });
      await waitFor(() => t.events.length > 0);
      expect(t.events).toEqual([{ typing: 'ana' }]);
    } finally {
      await t.stop();
    }
  });
});

describe('what a sync node says while its bus is away', () => {
  test('19 failed sweeps are 5 error lines and 5 monitor events, then ONE recovery line', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = spyOn(logger, 'info').mockImplementation(() => undefined);
    spies.push(error, info);
    const reports = memoryErrorReporter();
    configureErrorReporting({ reporter: reports, enabled: true });
    const clock = frozenClock(1_700_000_000_000);
    const broker = new FakeNatsBroker({ clock });
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      backoff: NO_WAIT,
      connect: fakeNatsConnect(broker),
      onError: () => undefined,
    });
    try {
      await transport.connect();
      const hub = new ChannelHub({ transport, sockets: new SocketRegistry({ clock }) });
      const presence = new PresenceRegistry({ transport, hub, clock });
      const topic = room.topic({ orgId: 'o1' });
      await presence.join(topic, { id: 'sock-1', actorId: null });
      const outage = busOutage();

      // The consumer's three minutes: one sweep every 10 s, every one refused.
      broker.drop();
      for (let sweep = 0; sweep < 19; sweep += 1) {
        outage.sweep(presence);
        await Bun.sleep(1);
      }
      const lines = error.mock.calls;
      expect(lines.map(([message]) => message)).toEqual(
        Array.from({ length: 5 }, () => SYNC_BUS_UNAVAILABLE),
      );
      expect(lines.map(([, fields]) => fields?.['failures'])).toEqual([1, 2, 4, 8, 16]);
      expect(lines.every(([, fields]) => fields?.['operation'] === 'presence.sweep')).toBe(true);
      expect(reports.events).toHaveLength(5);
      expect(info.mock.calls).toEqual([]);

      broker.restore();
      outage.sweep(presence);
      await Bun.sleep(1);
      outage.sweep(presence);
      await Bun.sleep(1);
      // The transport says its own drop is over (one failure: the drop); the node, its 19.
      expect(info.mock.calls).toEqual([
        ['nats transport recovered', { transport: 'nats', after: 1 }],
        [`${SYNC_BUS_UNAVAILABLE} recovered`, { after: 19 }],
      ]);
      expect(error.mock.calls).toHaveLength(5);
    } finally {
      resetErrorReporting();
      await transport.close();
    }
  });

  test('a failure that is NOT the bus is said every time, as before', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    spies.push(error);
    const outage = busOutage();
    for (let failure = 0; failure < 3; failure += 1) {
      outage.detach(Promise.reject(new TypeError('a policy threw')), 'presence.leave', 'room.o1');
    }
    await Bun.sleep(1);
    expect(error.mock.calls.map(([message, fields]) => [message, fields?.['at']])).toEqual(
      Array.from({ length: 3 }, () => ['presence.leave failed', 'room.o1']),
    );
    expect(outage.refused(new TypeError('nope'), 'sync.frame')).toBe(false);
  });
});
