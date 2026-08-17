// One question, one answer, whichever `Transport` is asked. `InProcessTransport` is what `x dev`,
// every test in this repo and every single-node deployment runs on; `NatsTransport` is what a fleet
// runs on — so a guarantee only one of them holds is a guarantee that passes CI and breaks on
// deploy. Each case asserts both transports in ONE test, so neither can move alone.
//
// What is deliberately NOT asserted here: that the two behave identically. They cannot — an
// in-memory map has no dropped connection and no max payload. What must hold is the CONTRACT:
// every refusal that reaches a caller is a coded `UltimateError` naming what to do about it.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { InProcessTransport, type Transport } from './fanout';
import type { NatsClient, NatsClientOptions, NatsConnect } from './nats-client';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport } from './nats-transport';

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const causeOf = (value: unknown): string => (isUltimateError(value) ? value.cause : '');

/**
 * A library failure this package never constructed — a bad subject, a payload over the server's
 * `max_payload`, a connection the client tore down underneath us. It extends `Error` on purpose:
 * rebuilding it as an `UltimateError` would prove the transport handles its own errors, which is
 * not the thing under test.
 */
class NatsError extends Error {
  override readonly name = 'NatsError';
}

/** The port, live, except for the one call the case wants to fail. */
function brokenClient(
  broker: FakeNatsBroker,
  override: (client: NatsClient) => Partial<NatsClient>,
): NatsConnect {
  const open = fakeNatsConnect(broker);
  return async (options: NatsClientOptions): Promise<NatsClient> => {
    const client = await open(options);
    return {
      get version(): string {
        return client.version;
      },
      get connected(): boolean {
        return client.connected;
      },
      publish: (subject, payload) => client.publish(subject, payload),
      subscribe: (subject, handler) => client.subscribe(subject, handler),
      request: (subject, payload, requestOptions) =>
        client.request(subject, payload, requestOptions),
      requestMany: (subject, payload, manyOptions) =>
        client.requestMany(subject, payload, manyOptions),
      close: () => client.close(),
      ...override(client),
    };
  };
}

function natsTransport(connect: NatsConnect): NatsTransport {
  return new NatsTransport({
    url: 'nats://bus.test:4222',
    bucket: 'x-test',
    clock: frozenClock(1_700_000_000_000),
    rng: () => 0.5,
    onError: () => undefined,
    connect,
  });
}

/** A closed in-process transport is the only refusal that one has, and it is already coded. */
async function closedInProcess(): Promise<Transport> {
  const transport = new InProcessTransport();
  await transport.close();
  return transport;
}

describe('a publish that the bus refuses', () => {
  test('is a coded X_TRANSPORT_UNAVAILABLE on both transports', async () => {
    const inProcess = await closedInProcess();
    const nats = natsTransport(
      brokenClient(new FakeNatsBroker({ clock: frozenClock(1_700_000_000_000) }), () => ({
        publish: () => {
          throw new NatsError('BAD_SUBJECT');
        },
      })),
    );

    const refused = await caught(inProcess.publish('x.change.posts.org-1', '{}'));
    const escaped = await caught(nats.publish('x.change.posts.org-1', '{}'));
    await nats.close();

    // `ChannelHub`'s bridge, `SocketRegistry` and the replicator all await this call. A raw
    // library error reaching one of them is an uncoded throw with no fix line, out of the one
    // seam this package exists to keep replaceable.
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(codeOf(escaped)).toBe('X_TRANSPORT_UNAVAILABLE');
    // The library's own words are evidence and belong in the cause; the fix is ours.
    expect(causeOf(escaped)).toContain('BAD_SUBJECT');
    expect(causeOf(escaped)).toContain('x.change.posts.org-1');
  });
});

describe('a subscribe that the bus refuses', () => {
  test('is a coded X_TRANSPORT_UNAVAILABLE on both transports', async () => {
    const inProcess = await closedInProcess();
    const nats = natsTransport(
      brokenClient(new FakeNatsBroker({ clock: frozenClock(1_700_000_000_000) }), () => ({
        subscribe: () => {
          throw new NatsError('PERMISSIONS_VIOLATION for subscription');
        },
      })),
    );

    const refused = await caught(inProcess.subscribe('x.change.>', () => undefined));
    const escaped = await caught(nats.subscribe('x.change.>', () => undefined));
    await nats.close();

    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(codeOf(escaped)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(escaped)).toContain('PERMISSIONS_VIOLATION');
  });
});

describe('a bus that answers is never dressed as a failure', () => {
  test('a live publish and subscribe still deliver on both transports', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const inProcess = new InProcessTransport();
    const nats = natsTransport(fakeNatsConnect(new FakeNatsBroker({ clock })));
    const seen: string[] = [];

    for (const transport of [inProcess, nats] as const) {
      await transport.subscribe('x.change.posts.>', (payload) => seen.push(payload));
      await transport.publish('x.change.posts.org-1', '{"id":"p1"}');
    }
    await nats.close();
    await inProcess.close();

    // The translation wraps a THROW, never a return: a transport that swallowed a working publish
    // into a coded error would satisfy both cases above and deliver nothing.
    expect(seen).toEqual(['{"id":"p1"}', '{"id":"p1"}']);
  });
});
