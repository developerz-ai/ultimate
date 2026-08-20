import { describe, expect, test } from 'bun:test';
import type { PgLogicalReplicationFeed } from './changefeed';
import { pgTimestampToEpochMs } from './pg-bytes';
import { changeLsn, commitPositionOf } from './pg-replication';
import {
  BrokenWriteWalsender,
  begin,
  commit,
  copyDone,
  FakeWalsender,
  type FixtureColumn,
  feedOver,
  INT8,
  insert,
  keepalive,
  OTHER_OID,
  ParkingWalsender,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  remove,
  start,
  UncloseableWalsender,
  update,
  xlog,
} from './pg-replication-fixture';

// ---- the ordering contract --------------------------------------------------------------------

describe('changeLsn', () => {
  test('sorts by commit position first and by position inside the transaction second', () => {
    const first = changeLsn(0x10n, 1);
    const second = changeLsn(0x10n, 2);
    const laterTx = changeLsn(0x11n, 1);
    expect(first < second).toBe(true);
    expect(second < laterTx).toBe(true);
    expect(first).toHaveLength(24);
  });

  test('a replayed transaction produces byte-identical lsns, which is what dedupes it', () => {
    expect(changeLsn(0x2b3c4dn, 7)).toBe(changeLsn(0x2b3c4dn, 7));
    expect(commitPositionOf(changeLsn(0x2b3c4dn, 7))).toBe(0x2b3c4dn);
  });
});

describe('decoded changes', () => {
  test('an insert becomes a ChangeEvent with the entity row shape and the tenant hoisted', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x1000n, 0n, 42)));
    server.push(xlog(insert(POSTS_OID, ['p1', 'Hello', 'org-1', '1990', 'USD', null])));
    server.push(xlog(commit(0x1000n, 0x1010n, 0n)));
    await settled(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      entity: 'posts',
      op: 'insert',
      before: null,
      after: {
        id: 'p1',
        title: 'Hello',
        orgId: 'org-1',
        price: { minor: 1990, currency: 'USD' },
      },
      lsn: changeLsn(0x1000n, 1),
      txid: '42',
      orgId: 'org-1',
      at: pgTimestampToEpochMs(0n),
    });
    expect(feed.lastLsn()).toBe(changeLsn(0x1000n, 1));
    await feed.stop();
  });

  test('a scaled amount reaches the subscriber scaled — one property, three columns', async () => {
    // $0.000002. Dropped, this row is delivered as $0.02: a 10,000x reinterpretation with no
    // error anywhere, and the live surface disagreeing with a refetch about one price.
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x1100n, 0n, 43)));
    server.push(xlog(insert(POSTS_OID, ['p2', 'Tokens', 'org-1', '2', 'USD', '6'])));
    server.push(xlog(commit(0x1100n, 0x1110n, 0n)));
    await settled(1);

    expect(events[0]?.after).toEqual({
      id: 'p2',
      title: 'Tokens',
      orgId: 'org-1',
      price: { minor: 2, currency: 'USD', scale: 6 },
    });
    await feed.stop();
  });

  test('every row of one transaction gets a strictly increasing lsn', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x2000n, 0n, 7)));
    for (let index = 1; index <= 5; index += 1) {
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', 'org-1', null, null, null])));
    }
    server.push(xlog(commit(0x2000n, 0x2100n, 0n)));
    await settled(5);

    const lsns = events.map((event) => event.lsn);
    expect(lsns).toHaveLength(5);
    expect([...lsns].sort()).toEqual(lsns);
    expect(new Set(lsns).size).toBe(5);
    await feed.stop();
  });

  test('a row for a table outside the entity list is skipped but still numbered', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'id', key: true }])));
    server.push(xlog(begin(0x3000n, 0n, 9)));
    server.push(xlog(insert(OTHER_OID, ['a1'])));
    server.push(xlog(insert(POSTS_OID, ['p9', 't', null, null, null, null])));
    server.push(xlog(commit(0x3000n, 0x3100n, 0n)));
    await settled(1);

    expect(events).toHaveLength(1);
    // Position 2, not 1: narrowing the entity list must not renumber the stream.
    expect(events[0]?.lsn).toBe(changeLsn(0x3000n, 2));
    expect(events[0]?.orgId).toBeNull();
    expect(feed.stats().skipped).toBe(1);
    await feed.stop();
  });

  test('update carries the old row and delete carries only what the identity replicated', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x4000n, 0n, 11)));
    server.push(
      xlog(
        update(
          POSTS_OID,
          ['p1', 'Old', 'org-1', null, null, null],
          ['p1', 'New', 'org-1', null, null, null],
        ),
      ),
    );
    server.push(xlog(remove(POSTS_OID, ['p1', null, null, null, null, null])));
    server.push(xlog(commit(0x4000n, 0x4100n, 0n)));
    await settled(2);

    expect(events[0]?.op).toBe('update');
    expect(events[0]?.before?.['title']).toBe('Old');
    expect(events[0]?.after?.['title']).toBe('New');
    expect(events[1]?.op).toBe('delete');
    // A key-only identity nulls the non-key columns, and half a money value is not money — so the
    // three price columns stay as themselves rather than folding into an invalid `{minor, currency}`.
    expect(events[1]?.before).toEqual({
      id: 'p1',
      title: null,
      orgId: null,
      priceMinor: null,
      priceCurrency: null,
      priceScale: null,
    });
    expect(events[1]?.after).toBeNull();
    await feed.stop();
  });

  // The counter, not the log line: a warning fires once at boot, and the thing an operator has to
  // be able to see afterwards is how many decisions were actually made on a partial row.
  test('a delete off a non-FULL relation is counted, and a FULL one is not', async () => {
    const partial = await start();
    partial.server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'd')));
    partial.server.push(xlog(begin(0x6000n, 0n, 13)));
    partial.server.push(xlog(remove(POSTS_OID, ['p1', null, null, null, null, null])));
    partial.server.push(xlog(commit(0x6000n, 0x6100n, 0n)));
    await partial.settled(1);
    expect(partial.feed.stats().delivered).toBe(1);
    expect(partial.feed.stats().partialBefore).toBe(1);
    await partial.feed.stop();

    const full = await start();
    full.server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'f')));
    full.server.push(xlog(begin(0x6000n, 0n, 13)));
    full.server.push(xlog(remove(POSTS_OID, ['p1', 'Old', 'org-1', null, null, null])));
    full.server.push(xlog(commit(0x6000n, 0x6100n, 0n)));
    await full.settled(1);
    expect(full.feed.stats().delivered).toBe(1);
    expect(full.feed.stats().partialBefore).toBe(0);
    await full.feed.stop();
  });

  test('an insert off a non-FULL relation is not counted — it carries no before at all', async () => {
    const { server, feed, settled } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'd')));
    server.push(xlog(begin(0x7000n, 0n, 14)));
    server.push(xlog(insert(POSTS_OID, ['p1', 'Hello', 'org-1', null, null, null])));
    server.push(xlog(commit(0x7000n, 0x7100n, 0n)));
    await settled(1);

    expect(feed.stats().delivered).toBe(1);
    expect(feed.stats().partialBefore).toBe(0);
    await feed.stop();
  });

  test('an update with no old tuple has before: null rather than a fabricated row', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x5000n, 0n, 12)));
    server.push(xlog(update(POSTS_OID, null, ['p1', 'New', null, null, null, null])));
    server.push(xlog(commit(0x5000n, 0x5100n, 0n)));
    await settled(1);

    expect(events[0]?.before).toBeNull();
    await feed.stop();
  });

  test('a resume drops the rows the cursor already covers and delivers the rest', async () => {
    const { server, events, settled, feed } = await start({ from: changeLsn(0x6000n, 2) });
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x6000n, 0n, 13)));
    for (let index = 1; index <= 4; index += 1) {
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', null, null, null, null])));
    }
    server.push(xlog(commit(0x6000n, 0x6100n, 0n)));
    await settled(2);

    expect(events.map((event) => event.after?.['id'])).toEqual(['p3', 'p4']);
    expect(feed.stats().replayed).toBe(2);
    expect(server.queries[4]).toContain('LOGICAL 0/6000');
    await feed.stop();
  });

  test('a replicated table with no text id is a loud configuration error', async () => {
    const { server, feed } = await start({ entities: ['audit_log'] });
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'seq', key: true }])));
    server.push(xlog(begin(0x7000n, 0n, 14)));
    server.push(xlog(insert(OTHER_OID, ['1'])));
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();

    // The recorded failure is the assertion: a delivered count of 0 is also what a fixture that
    // never decoded, or a pump that never started, would produce.
    expect(feed.stats().failure).toContain('X_REPLICATION_PROTOCOL');
    expect(feed.stats().failure).toContain('audit_log');
    expect(feed.stats().failure).toContain('no text id column');
    expect(feed.stats().delivered).toBe(0);
    await feed.stop();
  });

  test('a bigint id is delivered as text, in range and out of it alike', async () => {
    const columns: readonly FixtureColumn[] = [
      { name: 'id', key: true, type: INT8 },
      { name: 'title' },
    ];
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', columns)));
    server.push(xlog(begin(0xb000n, 0n, 21)));
    server.push(xlog(insert(POSTS_OID, ['42', 'small'])));
    server.push(xlog(insert(POSTS_OID, ['9223372036854775807', 'large'])));
    server.push(xlog(commit(0xb000n, 0xb100n, 0n)));
    await settled(2);

    // A safe int8 decodes as a number and a large one as text; `Row.id` is text either way, or the
    // same table would identify small rows by number and large rows by string.
    expect(events.map((event) => event.after?.['id'])).toEqual(['42', '9223372036854775807']);
    await feed.stop();
  });

  test('the confirm timer stops with the pump it confirms for', async () => {
    const { server, feed } = await start({ entities: ['audit_log'], statusIntervalMs: 5 });
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'seq', key: true }])));
    server.push(xlog(begin(0x7100n, 0n, 22)));
    server.push(xlog(insert(OTHER_OID, ['1'])));
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    const confirmations = server.standby.length;
    await Bun.sleep(30);

    // A dead loop must stop telling the walsender it is keeping up.
    expect(server.standby.length).toBe(confirmations);
    await feed.stop();
  });
});

// ---- what a dead pump has to release ----------------------------------------------------------

/** Nothing here is real I/O, so draining the microtask queue is a deterministic "let it finish". */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
};

/** A feed that dials a *fresh* walsender each time — the only way to watch a restart redial. */
const redialable = (): { feed: PgLogicalReplicationFeed; servers: FakeWalsender[] } => {
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
    expect((failure as { fix?: string }).fix).toContain("ALTER SYSTEM SET wal_level = 'logical'");
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
    server.push(xlog(insert(POSTS_OID, ['p1', 't', null, null, null, null])));
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
    server.push(xlog(insert(POSTS_OID, ['p1', 't', null, null, null, null])));
    server.push(xlog(commit(0xa000n, 0xa100n, 0n)));
    await settled(1);
    await feed.stop();

    expect(server.standby.at(-1)?.position).toBe(0xa100n);
    expect(server.closed).toBe(true);
  });
});
