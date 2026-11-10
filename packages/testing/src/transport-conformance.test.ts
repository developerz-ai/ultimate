// The transport suite over the in-process bus and `NatsTransport` on the in-memory NATS server, and
// the proof it can fail: a bus that matches subjects by prefix. Below it, the cases only a NATS
// client can stage — a library that throws — lifted from `realtime/src/transport-parity.test.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/adapter';
import type { NatsClient, NatsClientOptions, NatsConnect } from '@ultimat3/realtime/server';
import {
  FakeNatsBroker,
  fakeNatsConnect,
  InProcessTransport,
  NatsTransport,
} from '@ultimat3/realtime/server';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';
import { TRANSPORT_CHECKS, transportConformance } from './transport-conformance';

const AT = 1_700_000_000_000;

function natsOver(connect: NatsConnect): NatsTransport {
  return new NatsTransport({
    url: 'nats://bus.test:4222',
    bucket: 'x-test',
    clock: frozenClock(AT),
    rng: () => 0.5,
    onError: () => undefined,
    connect,
  });
}

describe(testName('unit', 'the in-process transport'), () => {
  behavesLike(transportConformance, () => new InProcessTransport());
});

describe(testName('unit', 'the NATS transport on the in-memory server'), () => {
  behavesLike(transportConformance, () =>
    natsOver(fakeNatsConnect(new FakeNatsBroker({ clock: frozenClock(AT) }))),
  );
});

/** Matches `x.a.*` against anything starting `x.a.` — the hand-rolled router that compiles. */
function prefixBus(): Transport {
  const inner = new InProcessTransport();
  return {
    name: 'prefix',
    shared: inner.shared,
    onReconnect: () => inner.onReconnect(),
    close: () => inner.close(),
    publish: (subject, payload) => inner.publish(subject, payload),
    subscribe: (subject, handler) =>
      inner.subscribe('>', (payload, on) => {
        if (on.startsWith(subject.replace(/[*>]$/, ''))) handler(payload, on);
      }),
  };
}

const check = (prefix: string) => {
  const found = TRANSPORT_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no transport check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a transport that breaks the contract fails conformance'), () => {
  test('a prefix router fails the wildcard check and passes the exact-subject one', async () => {
    await check('a publish reaches').run(prefixBus());
    await expect(check('`*` matches exactly one token').run(prefixBus())).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = TRANSPORT_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 */
class NatsError extends Error {
  override readonly name = 'NatsError';
}

/** The client, live, except for the one call a case wants to fail. */
function brokenClient(override: Partial<NatsClient>): NatsConnect {
  const open = fakeNatsConnect(new FakeNatsBroker({ clock: frozenClock(AT) }));
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
      flush: () => client.flush(),
      close: () => client.close(),
      ...override,
    };
  };
}

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

// `ChannelHub`'s bridge, `SocketRegistry` and the replicator await these calls: a raw library error
// reaching one of them is an uncoded throw with no fix line, out of the seam that keeps it
// swappable.
describe(
  testName('unit', 'a NATS library throw is a coded refusal, its words in the cause'),
  () => {
    test('a publish the library refuses is X_TRANSPORT_UNAVAILABLE naming it', async () => {
      const bus = natsOver(
        brokenClient({
          publish: () => {
            throw new NatsError('BAD_SUBJECT');
          },
        }),
      );
      const escaped = await caught(bus.publish('x.change.posts.org-1', '{}'));
      await bus.close();
      expect(isUltimateError(escaped) ? escaped.code : String(escaped)).toBe(
        'X_TRANSPORT_UNAVAILABLE',
      );
      const cause = isUltimateError(escaped) ? escaped.cause : '';
      expect(cause).toContain('BAD_SUBJECT');
      expect(cause).toContain('x.change.posts.org-1');
    });

    test('a subscribe the library refuses is X_TRANSPORT_UNAVAILABLE', async () => {
      const bus = natsOver(
        brokenClient({
          subscribe: () => {
            throw new NatsError('PERMISSIONS_VIOLATION for subscription');
          },
        }),
      );
      const escaped = await caught(bus.subscribe('x.change.>', () => undefined));
      await bus.close();
      expect(isUltimateError(escaped) ? escaped.code : String(escaped)).toBe(
        'X_TRANSPORT_UNAVAILABLE',
      );
      expect(isUltimateError(escaped) ? escaped.cause : '').toContain('PERMISSIONS_VIOLATION');
    });
  },
);
