// Tests for the bus as a role that only PUBLISHES sees it: dialled in the background, never
// awaited by the boot, refused at once while it is down, and resumed with no restart. Until
// 2026-10 every role awaited the first dial and the JetStream bucket, so a web, worker or
// scheduler pod that restarted while NATS was down never got past boot.

import { describe, expect, test } from 'bun:test';
import { frozenClock, installLogSink, isUltimateError } from '@ultimat3/core';
import { ManualScheduler } from './client-harness-fixture';
import type { NatsClient, NatsConnect } from './nats-client';
import { DIAL_TIMEOUT_MS } from './nats-dial-wait';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport, type NatsTransportOptions } from './nats-transport';
import type { ReconnectBackoff } from './thundering-herd';
import { BUS_CONNECT_WAIT_MS } from './transport-env';
import { turns, untilTurn } from './turns-fixture';

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const causeOf = (value: unknown): string => (isUltimateError(value) ? value.cause : String(value));

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/**
 * Lets the dial loop's backoff run out `count` times by hand: each wait is armed (the loop is
 * parked, not spinning) and fired, and the next dial is awaited — never a wall-clock wait.
 */
async function fireBackoffs(timers: ManualScheduler, attempts: () => number, count: number) {
  for (let fired = 0; fired < count; fired += 1) {
    await untilTurn(() => timers.pending !== null, `backoff #${fired + 1} armed`);
    const before = attempts();
    timers.fire();
    await untilTurn(() => attempts() > before, `the dial after backoff #${fired + 1}`);
  }
}

const QUICK: ReconnectBackoff = { base: 5, max: 5, factor: 1, jitter: 'none' };

function harness() {
  const clock = frozenClock(1_700_000_000_000);
  const broker = new FakeNatsBroker({ clock });
  const open = fakeNatsConnect(broker);
  const reported: unknown[] = [];
  let attempts = 0;
  /** The dial loop's backoff wait: armed here, ended only by `timers.fire()` or `close()`. */
  const timers = new ManualScheduler();
  const connect: NatsConnect = async (options) => {
    attempts += 1;
    return open(options);
  };
  const transport = (overrides: Partial<NatsTransportOptions> = {}): NatsTransport =>
    new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      backoff: QUICK,
      connect,
      scheduler: timers.schedule,
      onError: (error) => reported.push(error),
      ...overrides,
    });
  const backoffs = (count: number): Promise<void> => fireBackoffs(timers, () => attempts, count);
  return { broker, reported, timers, transport, backoffs, attempts: () => attempts };
}

describe('NatsTransport.connectInBackground', () => {
  test('returns with the bus down, and a publish is refused at once rather than parked', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();

    transport.connectInBackground();
    expect(transport.connected).toBe(false);
    await bus.backoffs(1);
    expect(bus.attempts()).toBe(2);
    const before = bus.attempts();
    const refused = await caught(transport.publish('x.channel.feed', 'lost'));

    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('has not connected yet');
    // Refused without a dial of its own: a request handler never waits on the bus.
    expect(bus.attempts()).toBe(before);
    await transport.close();
  });

  test('the dial is retried on the backoff, never in a spin', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport({
      backoff: { base: 20, max: 20, factor: 1, jitter: 'none' },
    });

    transport.connectInBackground();
    await untilTurn(() => bus.timers.pending !== null, 'the first refusal armed a backoff');
    // Parked on the wait: however many turns pass, nothing dials until it runs out.
    await turns(50);
    expect(bus.attempts()).toBe(1);
    expect(bus.timers.pending).toBe(20);

    // And each wait that runs out buys exactly one dial, on the policy's delay every time.
    await bus.backoffs(3);
    await turns(50);
    expect(bus.attempts()).toBe(4);
    expect(bus.timers.delays).toEqual([20, 20, 20, 20]);
    await transport.close();
  });

  test('once the bus is up it publishes with no restart, and says so to its listeners', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();
    let announced = 0;
    transport.onReconnect(() => {
      announced += 1;
    });
    transport.connectInBackground();
    await bus.backoffs(1);

    bus.broker.offline = false;
    await untilTurn(() => bus.timers.pending !== null, 'the second refusal armed a backoff');
    bus.timers.fire();
    await untilTurn(() => transport.connected, 'the dial after the bus came back');

    expect(transport.connected).toBe(true);
    expect(announced).toBe(1);
    const seen: string[] = [];
    bus.broker
      .client()
      .subscribe('x.channel.>', (message) => seen.push(new TextDecoder().decode(message.payload)));
    await transport.publish('x.channel.feed', 'after');
    expect(seen).toEqual(['after']);
    await transport.close();
  });

  test('a second call, and a call on a connected transport, start no second dial', async () => {
    const bus = harness();
    const transport = bus.transport();
    transport.connectInBackground();
    transport.connectInBackground();
    await untilTurn(() => transport.connected, 'the background dial landed');
    transport.connectInBackground();
    await turns(50);

    expect(bus.attempts()).toBe(1);
    expect(bus.timers.delays).toEqual([]);
    expect(bus.broker.clients).toHaveLength(1);
    await transport.close();
  });

  test('close() ends the loop: no dial after it, and no client left open', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();
    transport.connectInBackground();
    await untilTurn(() => bus.timers.pending !== null, 'the first refusal armed a backoff');

    await transport.close();
    const after = bus.attempts();
    bus.broker.offline = false;
    // The wait close() cut short is disarmed: no timer is left that could dial again.
    expect(bus.timers.pending).toBeNull();
    await turns(50);

    expect(bus.attempts()).toBe(after);
    expect(bus.broker.clients).toHaveLength(0);
  });
});

describe('NatsTransport, the dial loop at its edges', () => {
  // The loop's memo used to be cleared one microtask AFTER the loop returned. A connection that
  // closed for good in that gap asked for a loop, was handed the finished one, and nothing ever
  // dialled again: every kept subscription stayed orphaned.
  test('a client lost in the microtask after the loop lands still starts a new loop', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const broker = new FakeNatsBroker({ clock });
    const open = fakeNatsConnect(broker);
    const dialled: { client: NatsClient; onClosed: (() => void) | undefined }[] = [];
    const connect: NatsConnect = async (options) => {
      const client = await open(options);
      dialled.push({ client, onClosed: options.onClosed });
      return client;
    };
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      backoff: QUICK,
      connect,
      onError: () => undefined,
    });
    let losses = 0;
    transport.onReconnect(() => {
      if (losses > 0) return;
      losses += 1;
      // Queued while the loop is still on the stack, so it runs after the loop's function has
      // returned and before any reaction to its promise: exactly the gap.
      queueMicrotask(() => {
        const first = dialled[0];
        if (first === undefined) expect.unreachable('no dial landed');
        void first.client.close();
        first.onClosed?.();
      });
    });

    transport.connectInBackground();
    await untilTurn(() => dialled.length === 2 && transport.connected, 'the lost client replaced');

    expect(dialled).toHaveLength(2);
    expect(transport.connected).toBe(true);
    await transport.close();
  });

  test('an onError that throws does not end the loop, and nothing is left unhandled', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const unhandled: unknown[] = [];
    const note = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', note);
    const transport = bus.transport({
      onError: () => {
        // What an app's reporter does when the thing it reports to is the thing that is down.
        JSON.parse('the sink is gone');
      },
    });
    try {
      transport.connectInBackground();
      await bus.backoffs(3);
      expect(bus.attempts()).toBe(4);

      bus.broker.offline = false;
      await bus.backoffs(1);
      await untilTurn(() => transport.connected, 'the dial after the bus came back');
      expect(transport.connected).toBe(true);
      // An unhandled rejection is reported after the microtasks drain: a few turns, not a delay.
      await turns(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
      await transport.close();
    }
  });

  // Claimed in the changelog and the ops page: an outage is said at once and then ever more
  // rarely, not once per dial per pod for as long as it lasts.
  test('a dial that keeps failing is reported on attempts 1, 2, 4, 8, … and on no other', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport({
      backoff: { base: 0, max: 0, factor: 1, jitter: 'none' },
    });

    transport.connectInBackground();
    await bus.backoffs(39);
    await untilTurn(() => bus.timers.pending !== null, 'the 40th refusal armed a backoff');
    await transport.close();

    // 40 failed attempts, and a line for each power of two among them: 1, 2, 4, 8, 16, 32.
    expect(bus.attempts()).toBe(40);
    expect(bus.reported).toHaveLength(6);
    expect(bus.reported.every((error) => codeOf(error) === 'X_TRANSPORT_UNAVAILABLE')).toBe(true);
  });

  // The LEVEL is the role's: a process that only publishes is degraded and still serving, so its
  // outage is a warning; a node that serves from the bus cannot do its job, so its is an error.
  // Either way an outage is 1, 2, 4, 8, … lines and ONE more when the bus answers.
  for (const [outageLevel, quiet] of [
    ['warn', 'error'],
    ['error', 'warn'],
  ] as const) {
    test(`an outage is logged at ${outageLevel}, thinned, and ended by one "recovered after N" line`, async () => {
      const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
      const releaseLogSink = installLogSink((line, level) => {
        const { msg, ...fields } = JSON.parse(line) as { msg: string } & Record<string, unknown>;
        if (msg.startsWith('nats transport')) lines.push({ level, msg, fields });
      });
      // Built here, not by the harness: this one has NO `onError`, so the logger line is the sink.
      const broker = new FakeNatsBroker();
      broker.offline = true;
      const open = fakeNatsConnect(broker);
      let attempts = 0;
      const bus = { attempts: () => attempts };
      const timers = new ManualScheduler();
      const transport = new NatsTransport({
        url: 'nats://bus.test:4222',
        bucket: 'x-test',
        backoff: { base: 0, max: 0, factor: 1, jitter: 'none' },
        scheduler: timers.schedule,
        connect: async (options) => {
          attempts += 1;
          return open(options);
        },
        outageLevel,
      });
      try {
        transport.connectInBackground();
        await fireBackoffs(timers, bus.attempts, 19);
        broker.offline = false;
        await fireBackoffs(timers, bus.attempts, 1);
        await untilTurn(() => transport.connected, 'the dial after the bus came back');
        await untilTurn(
          () => lines.some((line) => line.msg === 'nats transport recovered'),
          'the recovered line',
        );

        const failed = lines.filter((line) => line.msg === 'nats transport error');
        const said = failed.map((line) => line.fields['failures']);
        // 20 failed dials, and only the powers of two among them written.
        const after = bus.attempts() - 1;
        expect(after).toBe(20);
        expect(said).toEqual([1, 2, 4, 8, 16]);
        expect(failed.every((line) => line.level === outageLevel)).toBe(true);
        expect(lines.filter((line) => line.level === quiet)).toEqual([]);
        expect(lines.filter((line) => line.msg === 'nats transport recovered')).toEqual([
          {
            level: 'info',
            msg: 'nats transport recovered',
            fields: expect.objectContaining({ transport: 'nats', after }),
          },
        ]);
      } finally {
        releaseLogSink();
        await transport.close();
      }
    });
  }

  test('a dial is given a connect timeout below the boot wait, so a black hole is an attempt that ends', async () => {
    const seen: (number | undefined)[] = [];
    const broker = new FakeNatsBroker();
    const open = fakeNatsConnect(broker);
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      connect: (options) => {
        seen.push(options.connectTimeoutMs);
        return open(options);
      },
    });
    await transport.connect();

    expect(seen).toEqual([DIAL_TIMEOUT_MS]);
    expect(DIAL_TIMEOUT_MS).toBeLessThan(BUS_CONNECT_WAIT_MS / 2);
    await transport.close();
  });
});

describe("NatsTransport with presenceBucket: 'first-use'", () => {
  test('a publisher connects to a server with no JetStream, and creates no bucket', async () => {
    const bus = harness();
    // Every JetStream call fails, as it does on a nats-server started without `-js`.
    bus.broker.fail('$JS.API', 1_000);
    const transport = bus.transport({ presenceBucket: 'first-use' });

    await transport.connect();

    expect(transport.connected).toBe(true);
    expect(bus.broker.streams).toEqual([]);
    const seen: string[] = [];
    bus.broker.client().subscribe('x.cache.invalidate', (message) => {
      seen.push(new TextDecoder().decode(message.payload));
    });
    await transport.publish('x.cache.invalidate', '["post:1"]');
    expect(seen).toEqual(['["post:1"]']);
    await transport.close();
  });

  test('the default still asserts the bucket at the dial: a sync node needs presence to serve', async () => {
    const bus = harness();
    bus.broker.fail('$JS.API', 1_000);
    const transport = bus.transport();

    expect(codeOf(await caught(transport.connect()))).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.connected).toBe(false);
    await transport.close();
  });

  test('the first use of the shared set asserts the bucket, once per client', async () => {
    const bus = harness();
    const transport = bus.transport({ presenceBucket: 'first-use' });
    await transport.connect();
    expect(bus.broker.streams).toEqual([]);

    await transport.shared.put('room', 'ada', '{}', 30_000);
    expect(bus.broker.streams).toEqual(['KV_x-test']);
    expect((await transport.shared.entries('room')).map((entry) => entry.member)).toEqual(['ada']);
    await transport.close();
  });
});

describe('NatsTransport.connect({ withinMs })', () => {
  test('a dial that does not land in time is refused, naming the server and the wait', async () => {
    const bus = harness();
    const landed = Promise.withResolvers<NatsClient>();
    const transport = bus.transport({ connect: () => landed.promise });

    const startedAt = performance.now();
    const refused = await caught(transport.connect({ withinMs: 40 }));

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('bus.test:4222');
    expect(causeOf(refused)).toContain('within 40ms');
    // No `fix` was passed, and the refusal still carries one: `TransportUnavailableError` supplies
    // its own when the caller names none (`errors.ts`), so no path leaves this code without a fix.
    expect(isUltimateError(refused) ? refused.fix : '').toBe(
      'x doctor — then check NATS_URL points at a reachable nats-server',
    );

    // The boot unwinds by closing the transport; the dial that lands afterwards is not leaked.
    await transport.close();
    landed.resolve(bus.broker.client());
    await untilTurn(() => bus.broker.clients.length === 0, 'the late client closed');
    expect(bus.broker.clients).toHaveLength(0);
  });

  test('a dial that lands in time resolves, and one the bus keeps refusing says so in the cause', async () => {
    const bus = harness();
    const up = bus.transport();
    await up.connect({ withinMs: 1_000 });
    expect(up.connected).toBe(true);
    await up.close();

    bus.broker.offline = true;
    const before = bus.attempts();
    const down = bus.transport();
    // The wait is the transport's own real timer (`landWithin`), long enough for two backoffs
    // fired by hand on any runner; the refusal is what ends it.
    const refusal = caught(down.connect({ withinMs: 250 }));
    await bus.backoffs(2);
    const refused = await refusal;
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('within 250ms');
    expect(causeOf(refused)).toContain('refused the connection');
    // Retried inside the wait, not given up on at the first refusal.
    expect(bus.attempts() - before).toBe(3);
    await down.close();
  });

  test('a bus that comes up inside the wait is a boot that succeeds', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();
    const connecting = transport.connect({ withinMs: 2_000 });
    await bus.backoffs(1);
    bus.broker.offline = false;
    await untilTurn(() => bus.timers.pending !== null, 'the second refusal armed a backoff');
    bus.timers.fire();

    await connecting;
    expect(transport.connected).toBe(true);
    await transport.close();
  });

  test('closing the transport under the wait ends it, coded', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();
    const connecting = caught(transport.connect({ withinMs: 5_000 }));
    await untilTurn(() => bus.timers.pending !== null, 'the first refusal armed a backoff');
    await transport.close();

    expect(codeOf(await connecting)).toBe('X_TRANSPORT_UNAVAILABLE');
  });
});

describe('NatsTransport.publish while the client is reconnecting', () => {
  test('is refused at once: the library would queue it without bound and replay it late', async () => {
    const bus = harness();
    const transport = bus.transport();
    await transport.connect();
    const seen: string[] = [];
    bus.broker
      .client()
      .subscribe('x.channel.>', (message) => seen.push(new TextDecoder().decode(message.payload)));

    bus.broker.drop();
    const refused = await caught(transport.publish('x.channel.feed', 'during'));
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('reconnecting');

    bus.broker.restore();
    await transport.publish('x.channel.feed', 'after');
    expect(seen).toEqual(['after']);
    await transport.close();
  });
});
