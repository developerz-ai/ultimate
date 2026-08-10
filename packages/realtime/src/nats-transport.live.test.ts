// The only proof that the bus client is right: a real nats-server, a real JetStream KV bucket, a
// real TCP socket. Everything else in this package drives an in-memory server — which cannot catch
// a header the server spells differently, a JetStream reply shape that moved, or a TTL nobody honours.
//
// Skips unless a JetStream-enabled server is configured. Locally:
//
//   docker run -d --name x-nats -p 4222:4222 nats:2.11-alpine -js
//   TEST_NATS_URL=nats://localhost:4222 bun test packages/realtime/src/nats-transport.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { NatsConnection } from './nats-connection';
import { kvGet } from './nats-jetstream';
import { encodeToken } from './nats-kv';
import { bunNatsStream, parseNatsUrl } from './nats-socket';
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
    const target = parseNatsUrl(url ?? '');
    const connection = await NatsConnection.open({ stream: await bunNatsStream(target), target });
    const kvKey = `${encodeToken(key)}.${encodeToken('brief')}`;

    expect(await kvGet(connection, BUCKET, kvKey)).toBeDefined();
    // Real seconds, deliberately: per-message TTL is the server's own clock, and that is the point.
    await Bun.sleep(3_500);

    expect(await kvGet(connection, BUCKET, kvKey)).toBeUndefined();
    await connection.close();
  }, 20_000);
});
