// Single responsibility: the node-loss probe, inverted, on a real server. A TCP proxy stops carrying
// the bytes of every connection it already holds while new ones still reach a healthy server: the
// state a pod sits in after a failover, wedged for the kernel's retransmit window. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import { type PostgresClient, postgresClient } from './client';
import { checkDb } from './db-health';
import type { DbError } from './errors';
import { UNANSWERED_GRACE_MS } from './pool-sweep';
import { sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

interface Link {
  readonly upstream: Promise<Socket<{ client: Socket<Link> }>>;
  dead: boolean;
}

interface Blackhole {
  readonly url: string;
  /** Every connection open now goes silent, both ways, with no FIN and no RST. */
  swallowOpenConnections(): void;
  opened(): number;
  stop(): void;
}

/** Forwards bytes to `target` until told to swallow what is open. New connections stay healthy. */
function blackholeProxy(target: URL): Blackhole {
  const links = new Set<Link>();
  let opened = 0;
  const server = Bun.listen<Link>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        opened += 1;
        const link: Link = {
          dead: false,
          upstream: Bun.connect<{ client: Socket<Link> }>({
            hostname: target.hostname,
            port: Number(target.port || 5432),
            data: { client },
            socket: {
              data(socket, bytes) {
                if (!link.dead) socket.data.client.write(bytes);
              },
              close(socket) {
                if (!link.dead) socket.data.client.end();
              },
              error() {},
            },
          }),
        };
        client.data = link;
        links.add(link);
      },
      data(client, bytes) {
        const link = client.data;
        if (link.dead) return;
        void link.upstream.then((upstream) => upstream.write(bytes));
      },
      close(client) {
        void client.data.upstream.then((upstream) => upstream.end());
      },
      error() {},
    },
  });
  const proxied = new URL(target);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(server.port);
  return {
    url: proxied.href,
    swallowOpenConnections() {
      for (const link of links) link.dead = true;
    },
    opened: () => opened,
    stop() {
      server.stop(true);
    },
  };
}

describe.skipIf(!hasPostgres)('live · a pool whose path died recovers without a restart', () => {
  const statementTimeoutMs = 500;
  const clients: PostgresClient[] = [];
  const proxies: Blackhole[] = [];

  const wedged = async (): Promise<{ client: PostgresClient; proxy: Blackhole }> => {
    const proxy = blackholeProxy(new URL(url ?? ''));
    proxies.push(proxy);
    const client = postgresClient({
      url: proxy.url,
      role: 'web',
      profile: { max: 4, statementTimeoutMs, drainTimeoutMs: 1_000 },
    });
    clients.push(client);
    await client.query(sql`select 1`);
    return { client, proxy };
  };

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
    for (const proxy of proxies.splice(0)) proxy.stop();
  });

  test('the hung statement rejects inside the bound plus 7 s, and the next one answers', async () => {
    const { client, proxy } = await wedged();
    const openedBefore = proxy.opened();
    proxy.swallowOpenConnections();

    const started = performance.now();
    const caught = (await client.query(sql`select 2`).catch((error: unknown) => error)) as DbError;
    const elapsed = performance.now() - started;

    expect(caught.code).toBe('X_DB_UNAVAILABLE');
    expect(caught.cause).toContain('select 2');
    expect(elapsed).toBeGreaterThanOrEqual(statementTimeoutMs + UNANSWERED_GRACE_MS - 1);
    expect(elapsed).toBeLessThan(statementTimeoutMs + 7_000);

    const rows = await client.query<{ ok: number }>(sql`select 3 as ok`);
    expect(rows[0]?.ok).toBe(3);
    expect(proxy.opened()).toBeGreaterThan(openedBefore);
    expect((await checkDb(client)).ok).toBe(true);
  }, 20_000);

  test('a plain statement behind a full pool refuses near the acquire bound, not at the sleep', async () => {
    // The full-pool probe: this answered `ok` at 2964 ms, where reserve() refused at 304 ms.
    const client = postgresClient({
      url: url ?? '',
      role: 'web',
      profile: { max: 1, acquireTimeoutMs: 300 },
    });
    clients.push(client);
    const running = client.query(sql`select pg_sleep(1.5)`);

    const started = performance.now();
    const caught = (await client.query(sql`select 1`).catch((error: unknown) => error)) as DbError;
    const elapsed = performance.now() - started;

    expect(caught.code).toBe('X_DB_POOL_EXHAUSTED');
    expect(elapsed).toBeLessThan(1_000);
    await running;
  }, 20_000);

  test('transactions hung on every slot: the next refused acquire replaces the pool', async () => {
    const proxy = blackholeProxy(new URL(url ?? ''));
    proxies.push(proxy);
    const client = postgresClient({
      url: proxy.url,
      role: 'worker',
      profile: { max: 2, statementTimeoutMs, acquireTimeoutMs: 300, drainTimeoutMs: 1_000 },
    });
    clients.push(client);
    const pins = [await client.reserve(), await client.reserve()];
    proxy.swallowOpenConnections();
    const hung = pins.map((pin) => pin.query(sql`select 'pinned'`).catch(() => undefined));

    const started = performance.now();
    let rows: readonly { ok: number }[] = [];
    // Each refusal before the bound is the pool being busy; the first after it finds it dead.
    while (rows.length === 0 && performance.now() - started < statementTimeoutMs + 7_000) {
      rows = await client.query<{ ok: number }>(sql`select 4 as ok`).catch((error: unknown) => {
        expect((error as DbError).code).toBe('X_DB_POOL_EXHAUSTED');
        return [];
      });
    }
    expect(rows[0]?.ok).toBe(4);
    for (const pin of pins) pin.release();
    await Promise.all(hung);
  }, 20_000);

  test('a server-side timeout never reaches the deadline, and costs no pool', async () => {
    const { client, proxy } = await wedged();
    const openedBefore = proxy.opened();

    const caught = (await client
      .query(sql`select pg_sleep(30)`)
      .catch((error: unknown) => error)) as DbError;
    expect(caught.code).toBe('X_DB_STATEMENT_TIMEOUT');

    await client.query(sql`select 1`);
    expect(proxy.opened()).toBe(openedBefore);
  }, 20_000);

  test('a LISTEN session comes back on the new pool, and carries a notification', async () => {
    const { client, proxy } = await wedged();
    let established = 0;
    const reestablished = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<string>();
    const channel = `x_wedge_${crypto.randomUUID().replaceAll('-', '_')}`;
    // Three cues: the first LISTEN, the retirement's loss cue (`redialOne` fires it at once, so a
    // waker stops trusting the dead session), then the new session's own. A notification sent
    // after the second lands on no session and is lost, as `listen.ts` says one is while down.
    await client.listen(channel, delivered.resolve, () => {
      established += 1;
      if (established === 3) reestablished.resolve();
    });

    proxy.swallowOpenConnections();
    await client.query(sql`select 2`).catch(() => undefined);
    await reestablished.promise;

    await client.query(sql`select pg_notify(${channel}, 'after')`);
    expect(await delivered.promise).toBe('after');
  }, 20_000);
});
