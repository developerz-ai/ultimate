// The only proof that the bus client is right: a real nats-server, a real JetStream KV bucket, a
// real TCP socket. Everything else in this package drives an in-memory bus — which cannot catch
// a header the server spells differently, a JetStream reply shape that moved, or a TTL nobody honours.
//
// Skips unless a JetStream-enabled server is configured. Locally:
//
//   docker run -d --name x-nats -p 4222:4222 nats:2.11-alpine -js
//   TEST_NATS_URL=nats://localhost:4222 bun test packages/realtime/src/nats-transport.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { parseNatsUrl } from './nats-client';
import { kvGet } from './nats-jetstream';
import { encodeToken } from './nats-kv';
import { openNatsClient } from './nats-lib-client';
import { NatsTransport } from './nats-transport';

const url = Bun.env['TEST_NATS_URL'];
const BUCKET = 'xlive';

/** The preload freezes the clock, so waiting is counted in polls rather than in elapsed time. */
const waitFor = async (done: () => boolean, polls = 200): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(25);
};

const started: NatsTransport[] = [];
const transport = (): NatsTransport => {
  const created = new NatsTransport({ url: url ?? '', bucket: BUCKET });
  started.push(created);
  return created;
};

afterAll(async () => {
  for (const created of started) await created.close();
});

interface Leg {
  /** The far side of this connection, once it is open. */
  peer: { write(bytes: Uint8Array): number; end(): void } | undefined;
  /** Bytes that arrived before the far side opened. */
  readonly early: Uint8Array[];
}

/**
 * A TCP relay in front of the real server, so a test can cut a connection without touching the
 * server: the container is shared, and stopping it is not this file's to do. `cut()` ends every
 * relayed connection the way a network partition does — both halves, no goodbye.
 */
async function relayTo(
  host: string,
  port: number,
): Promise<{ port: number; cut(): void; stop(): void }> {
  const clients = new Set<{ end(): void }>();
  const listener = Bun.listen<Leg>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = { peer: undefined, early: [] };
        clients.add(client);
        // Not awaited: `open` is synchronous, and the server speaks first (INFO) once this lands.
        void Bun.connect<Leg>({
          hostname: host,
          port,
          socket: {
            open(upstream) {
              upstream.data = { peer: client, early: [] };
              client.data.peer = upstream;
              for (const bytes of client.data.early.splice(0)) upstream.write(bytes);
            },
            data(_upstream, bytes) {
              client.write(bytes);
            },
            close() {
              client.end();
            },
            error() {
              client.end();
            },
          },
        }).catch(() => client.end());
      },
      data(client, bytes) {
        // Copied: the runtime reuses the chunk's buffer once this handler returns.
        if (client.data.peer === undefined) client.data.early.push(Uint8Array.from(bytes));
        else client.data.peer.write(bytes);
      },
      close(client) {
        clients.delete(client);
        client.data.peer?.end();
      },
    },
  });
  return {
    port: listener.port,
    cut: () => {
      for (const client of [...clients]) client.end();
    },
    stop: () => listener.stop(true),
  };
}

describe.skipIf(url === undefined)('NatsTransport against a real nats-server', () => {
  test('connects, and creates the KV bucket when the cluster has none', async () => {
    const bus = transport();
    await bus.connect();

    expect(bus.connected).toBe(true);
  });

  test('a change published on one connection reaches a wildcard subscriber on another', async () => {
    const publisher = transport();
    const subscriber = transport();
    const seen: string[] = [];
    await subscriber.subscribe('x.change.posts.*', (payload, subject) => {
      seen.push(`${subject}=${payload}`);
    });
    await publisher.publish('x.change.posts.org-1', '{"op":"insert","id":"p1"}');

    await waitFor(() => seen.length > 0);

    expect(seen).toEqual(['x.change.posts.org-1={"op":"insert","id":"p1"}']);
  });

  test('a subscriber only gets the subjects it asked for', async () => {
    const publisher = transport();
    const subscriber = transport();
    const seen: string[] = [];
    await subscriber.subscribe('x.change.comments.*', (payload) => seen.push(payload));
    await publisher.publish('x.change.posts.org-1', 'wrong-entity');
    await publisher.publish('x.change.comments.org-1', 'right-entity');

    await waitFor(() => seen.length > 0);

    expect(seen).toEqual(['right-entity']);
  });

  test('presence written on one node is listed on another; touch and drop agree across both', async () => {
    const first = transport();
    const second = transport();
    const key = 'presence.live.room';
    for (const member of ['m1', 'm2']) await first.shared.drop(key, member);

    await first.shared.put(key, 'm1', '{"actorId":"alice"}', 30_000);
    await first.shared.put(key, 'm2', '{"actorId":"bob"}', 30_000);
    const listed = await second.shared.entries(key);

    expect(listed.map((entry) => entry.member).sort()).toEqual(['m1', 'm2']);
    expect(listed.find((entry) => entry.member === 'm1')?.value).toBe('{"actorId":"alice"}');
    expect(await second.shared.touch(key, 'm1', 30_000)).toBe(true);
    expect(await second.shared.touch(key, 'ghost', 30_000)).toBe(false);

    await first.shared.drop(key, 'm1');
    expect((await second.shared.entries(key)).map((entry) => entry.member)).toEqual(['m2']);
    await first.shared.drop(key, 'm2');
  });

  test('a member id carrying a dot survives the subject encoding', async () => {
    const bus = transport();
    const key = 'presence.live.dotted';
    await bus.shared.put(key, 'socket.7', 'value', 30_000);

    expect((await bus.shared.entries(key)).map((entry) => entry.member)).toEqual(['socket.7']);
    await bus.shared.drop(key, 'socket.7');
  });

  test('the server expires a member on its own: no client sweep, no heartbeat', async () => {
    const bus = transport();
    const key = 'presence.live.ttl';
    await bus.shared.put(key, 'brief', 'x', 1_000);
    // Read straight off the bucket rather than through `shared`: the claim is that the *server*
    // expired the member, which a client-side filter over a live entry would answer identically.
    const client = await openNatsClient({ url: url ?? '' });
    const kvKey = `${encodeToken(key)}.${encodeToken('brief')}`;

    expect(await kvGet(client, BUCKET, kvKey)).toBeDefined();
    // Real seconds, deliberately: per-message TTL is the server's own clock, and that is the point.
    await Bun.sleep(3_500);

    expect(await kvGet(client, BUCKET, kvKey)).toBeUndefined();
    await client.close();
  }, 20_000);

  // Nothing in a unit test proves the LIBRARY tells the port it reconnected: the fake bus calls the
  // option by hand. Here the connection is really cut and really re-established.
  test('a connection the library re-establishes is announced, and its subscriptions survive', async () => {
    const target = parseNatsUrl(url ?? '');
    const relay = await relayTo(target.host, target.port);
    const credentials =
      target.token !== undefined
        ? `${encodeURIComponent(target.token)}@`
        : target.user !== undefined && target.pass !== undefined
          ? `${encodeURIComponent(target.user)}:${encodeURIComponent(target.pass)}@`
          : '';
    const bus = new NatsTransport({
      url: `nats://${credentials}127.0.0.1:${relay.port}`,
      bucket: BUCKET,
      // Zero, and it has to be: the library redials a server once `lastConnect + wait <= Date.now()`,
      // and the test preload freezes `Date.now()` — any positive wait is never reached.
      backoff: { baseMs: 0, maxMs: 0, factor: 1, jitter: 'none' },
      onError: () => undefined,
    });
    started.push(bus);
    let reconnects = 0;
    bus.onReconnect(() => {
      reconnects += 1;
    });
    const seen: string[] = [];
    const subject = `x.change.reconnect.${Bun.randomUUIDv7()}`;
    try {
      await bus.subscribe(subject, (payload) => seen.push(payload));
      await bus.publish(subject, 'before');
      await waitFor(() => seen.length === 1);
      expect(reconnects).toBe(0);

      relay.cut();
      await waitFor(() => reconnects > 0);
      expect(reconnects).toBeGreaterThanOrEqual(1);

      // The subscription came back with the connection: nobody re-subscribed.
      await waitFor(() => bus.connected);
      await bus.publish(subject, 'after');
      await waitFor(() => seen.length === 2);
      expect(seen).toEqual(['before', 'after']);
    } finally {
      await bus.close();
      relay.stop();
    }
  }, 30_000);
});
