// What a dead replication pump has to release, and the slot confirmation that follows a commit:
// a stream that ends or breaks is a failure that frees its walsender. Split from pg-replication.test.ts.

import { describe, expect, test } from 'bun:test';
import type { PostgresChangeFeed } from './changefeed';
import {
  BrokenWriteWalsender,
  begin,
  commit,
  copyDone,
  FakeWalsender,
  feedOver,
  insert,
  keepalive,
  OTHER_OID,
  ParkingWalsender,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  start,
  UncloseableWalsender,
  xlog,
} from './pg-replication-fixture';

// ---- the ordering contract --------------------------------------------------------------------

// ---- what a dead pump has to release ----------------------------------------------------------

/** Nothing here is real I/O, so draining the microtask queue is a deterministic "let it finish". */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
};

/** A feed that dials a *fresh* walsender each time — the only way to watch a restart redial. */
const redialable = (): { feed: PostgresChangeFeed; servers: FakeWalsender[] } => {
  const servers: FakeWalsender[] = [];
  return {
    servers,
    feed: feedOver(() => {
      const server = new FakeWalsender();
      servers.push(server);
      return Promise.resolve(server);
    }),
  };
};

describe('a stream that dies', () => {
  test('a walsender that ends the copy is a failure, not a stream still reporting itself live', async () => {
    const { feed, servers } = redialable();
    await feed.start({ onChange: () => undefined });
    servers[0]?.push(copyDone());
    await settle();

    // A `null` failure here is a replicator that reads no WAL and answers /readyz as ready.
    expect(feed.stats().failure).toContain('ended the copy stream');
    expect(servers[0]?.closed).toBe(true);
    await feed.stop();
  });

  test('a pump that threw closes its connection instead of leaving the socket open', async () => {
    const { server, feed } = await start({ entities: ['audit_log'] });
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'seq', key: true }])));
    server.push(xlog(begin(0x7200n, 0n, 23)));
    server.push(xlog(insert(OTHER_OID, ['1'])));
    await settle();

    expect(feed.stats().failure).toContain('X_REPLICATION_PROTOCOL');
    // The failure was already recorded before this fix; what was leaked is the connection.
    expect(server.closed).toBe(true);
    await feed.stop();
  });

  test('a restart dials again, and never inherits the death that preceded it', async () => {
    const { feed, servers } = redialable();
    await feed.start({ onChange: () => undefined });
    servers[0]?.push(copyDone());
    await settle();

    // The dead stream left `#running` true, so this `start()` used to be a silent no-op — and
    // when it was not, it overwrote a `#connection` nobody had closed.
    await feed.start({ onChange: () => undefined });
    expect(servers).toHaveLength(2);
    expect(feed.stats().failure).toBeNull();

    await feed.stop();
    // The goodbye reached the connection this start opened, which is the one `stop()` owns.
    expect(servers[1]?.standby).not.toHaveLength(0);
    expect(servers[1]?.closed).toBe(true);
  });

  test('stop() after a death is a no-op, not a confirm written to a dead socket', async () => {
    const { feed, servers } = redialable();
    await feed.start({ onChange: () => undefined });
    const before = servers[0]?.standby.length ?? -1;
    servers[0]?.push(copyDone());
    await settle();
    await feed.stop();

    expect(servers[0]?.standby).toHaveLength(before);
  });

  test('stop() waits for a pump that is still releasing its connection', async () => {
    const server = new ParkingWalsender();
    const feed = feedOver(() => Promise.resolve(server));
    await feed.start({ onChange: () => undefined });
    server.push(copyDone());
    // The death is now parked mid-goodbye: `#connection` is already null, the socket is not.
    await server.parked;

    let stopped = false;
    const stopping = feed.stop().then(() => {
      stopped = true;
    });
    await settle();

    // A `stop()` that returns here reports a released slot to a supervisor that is about to
    // start the next process — which then finds the slot still `active`.
    expect(stopped).toBe(false);
    expect(server.closed).toBe(false);

    server.release();
    await stopping;
    expect(server.closed).toBe(true);
  });

  test('a goodbye that fails still closes the socket, and reports only once it has', async () => {
    const server = new BrokenWriteWalsender();
    const feed = feedOver(() => Promise.resolve(server));
    await feed.start({ onChange: () => undefined });

    await expect(feed.stop()).rejects.toThrow('socket is already closed');
    // The confirm threw, and under the old code it left `stop()` right there: the socket stayed
    // open and the slot stayed `active`, while the supervisor had already been told the teardown
    // was over. Closed *by the time the failure is observed* is the whole assertion.
    expect(server.closed).toBe(true);
  });

  test('a boot failure is what start() reports, not the teardown that failed after it', async () => {
    const server = new UncloseableWalsender({ walLevel: 'replica' });
    const feed = feedOver(() => Promise.resolve(server));

    const failure = await feed
      .start({ onChange: () => undefined })
      .catch((error: unknown) => error);
    // `start()` fails over `stop()`, which now raises on its own once cleanup has settled. The
    // wal_level is the diagnosis the operator can act on; the close that also failed is not.
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((failure as { fix?: string }).fix).toContain('wal_level=logical');
    expect(server.closed).toBe(true);
  });

  test('a restart waits for the dead pump to let go of the slot before it dials', async () => {
    const parking = new ParkingWalsender();
    const restarted = new FakeWalsender();
    const dials: { readonly deadSocketClosed: boolean }[] = [];
    const feed = feedOver(() => {
      const server = dials.length === 0 ? parking : restarted;
      dials.push({ deadSocketClosed: parking.closed });
      return Promise.resolve(server);
    });
    await feed.start({ onChange: () => undefined });
    parking.push(copyDone());
    // `#die` has cleared `#running` and nulled `#connection`, and is now parked mid-goodbye — so
    // the walsender that "died" still owns the replication slot.
    await parking.parked;

    let started = false;
    const restarting = feed.start({ onChange: () => undefined }).then(() => {
      started = true;
    });
    await settle();

    // Dialling here is the collision: two walsenders, one slot, and the loser gets "already active".
    expect(dials).toHaveLength(1);
    expect(started).toBe(false);

    parking.release();
    await restarting;
    expect(dials.map((dial) => dial.deadSocketClosed)).toEqual([false, true]);

    await feed.stop();
    // And the `stop()` that follows owns the connection the restart opened — it cannot return on a
    // pump that a restart replaced, because a restart no longer replaces one that is still going.
    expect(restarted.standby).not.toHaveLength(0);
    expect(restarted.closed).toBe(true);
  });
});

describe('slot confirmation', () => {
  test('a keepalive asking for a reply is answered with the confirmed position', async () => {
    const { server, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x8000n, 0n, 15)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', 'org-1', null, null, null])));
    server.push(xlog(commit(0x8000n, 0x8100n, 0n)));
    await settled(1);
    server.push(keepalive(0x9000n, 1));
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();

    const last = server.standby.at(-1);
    expect(last?.position).toBe(0x9000n);
    expect(last?.at).toBe(Date.UTC(2026, 7, 9, 12, 0, 0));
    await feed.stop();
  });

  test('stop confirms what was delivered before it says goodbye', async () => {
    const { server, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0xa000n, 0n, 16)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', 'org-1', null, null, null])));
    server.push(xlog(commit(0xa000n, 0xa100n, 0n)));
    await settled(1);
    await feed.stop();

    expect(server.standby.at(-1)?.position).toBe(0xa100n);
    expect(server.closed).toBe(true);
  });
});
