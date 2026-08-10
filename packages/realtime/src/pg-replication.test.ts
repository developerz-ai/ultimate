import { describe, expect, test } from 'bun:test';
import { PgLogicalReplicationFeed } from './changefeed';
import { pgTimestampToEpochMs } from './pg-bytes';
import { changeLsn, commitPositionOf } from './pg-replication';
import {
  begin,
  commit,
  type FixtureColumn,
  INT8,
  insert,
  keepalive,
  OTHER_OID,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  remove,
  start,
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

describe('PgLogicalReplicationFeed', () => {
  test('an empty entity list is refused before a socket is opened', () => {
    expect(
      () =>
        new PgLogicalReplicationFeed({
          url: 'postgres://x@y/z',
          slot: 's',
          publication: 'p',
          entities: [],
        }),
    ).toThrow(/empty entity list/);
  });

  test('preflights wal_level, the publication and the slot before it streams', async () => {
    const { server, feed } = await start();
    expect(server.queries[0]).toBe('SHOW wal_level');
    expect(server.queries[1]).toContain('pg_publication');
    expect(server.queries[2]).toContain('pg_replication_slots');
    expect(server.queries[3]).toStartWith('START_REPLICATION SLOT ultimate_slot LOGICAL 0/0');
    expect(server.queries[3]).toContain("publication_names 'ultimate_pub'");
    await feed.stop();
  });

  test('creates the slot when there is none, and never touches an existing one', async () => {
    const fresh = await start({ script: { slotPlugin: null } });
    expect(fresh.server.queries[3]).toBe(
      "SELECT pg_create_logical_replication_slot('ultimate_slot', 'pgoutput')",
    );
    await fresh.feed.stop();

    const existing = await start();
    expect(existing.server.queries.some((sql) => sql.includes('pg_create'))).toBe(false);
    await existing.feed.stop();
  });

  test('a non-logical wal_level names the exact statement that fixes it', async () => {
    const failure = await start({ script: { walLevel: 'replica' } }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((failure as { fix?: string }).fix).toContain("ALTER SYSTEM SET wal_level = 'logical'");
  });

  test('a missing publication and a foreign slot plugin each carry their own fix', async () => {
    const noPublication = await start({ script: { publicationExists: false } }).catch(
      (error: unknown) => error,
    );
    expect((noPublication as { fix?: string }).fix).toBe(
      'CREATE PUBLICATION ultimate_pub FOR ALL TABLES;',
    );

    const wrongPlugin = await start({ script: { slotPlugin: 'wal2json' } }).catch(
      (error: unknown) => error,
    );
    expect((wrongPlugin as { fix?: string }).fix).toContain('pg_drop_replication_slot');
  });

  test('an identifier outside [a-z_][a-z0-9_]* never reaches a replication command', async () => {
    const failure = await start({ entities: ["posts'; drop table users --"] }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
  });
});

describe('decoded changes', () => {
  test('an insert becomes a ChangeEvent with the entity row shape and the tenant hoisted', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x1000n, 0n, 42)));
    server.push(xlog(insert(POSTS_OID, ['p1', 'Hello', 'org-1', '1990', 'USD'])));
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

  test('every row of one transaction gets a strictly increasing lsn', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x2000n, 0n, 7)));
    for (let index = 1; index <= 5; index += 1) {
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', 'org-1', null, null])));
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
    server.push(xlog(insert(POSTS_OID, ['p9', 't', null, null, null])));
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
        update(POSTS_OID, ['p1', 'Old', 'org-1', null, null], ['p1', 'New', 'org-1', null, null]),
      ),
    );
    server.push(xlog(remove(POSTS_OID, ['p1', null, null, null, null])));
    server.push(xlog(commit(0x4000n, 0x4100n, 0n)));
    await settled(2);

    expect(events[0]?.op).toBe('update');
    expect(events[0]?.before?.['title']).toBe('Old');
    expect(events[0]?.after?.['title']).toBe('New');
    expect(events[1]?.op).toBe('delete');
    // A key-only identity nulls the non-key columns, and half a money value is not money — so the
    // two price columns stay as themselves rather than folding into an invalid `{minor, currency}`.
    expect(events[1]?.before).toEqual({
      id: 'p1',
      title: null,
      orgId: null,
      priceMinor: null,
      priceCurrency: null,
    });
    expect(events[1]?.after).toBeNull();
    await feed.stop();
  });

  test('an update with no old tuple has before: null rather than a fabricated row', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x5000n, 0n, 12)));
    server.push(xlog(update(POSTS_OID, null, ['p1', 'New', null, null, null])));
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
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', null, null, null])));
    }
    server.push(xlog(commit(0x6000n, 0x6100n, 0n)));
    await settled(2);

    expect(events.map((event) => event.after?.['id'])).toEqual(['p3', 'p4']);
    expect(feed.stats().replayed).toBe(2);
    expect(server.queries[3]).toContain('LOGICAL 0/6000');
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

describe('slot confirmation', () => {
  test('a keepalive asking for a reply is answered with the confirmed position', async () => {
    const { server, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x8000n, 0n, 15)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', null, null, null])));
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
    server.push(xlog(insert(POSTS_OID, ['p1', 't', null, null, null])));
    server.push(xlog(commit(0xa000n, 0xa100n, 0n)));
    await settled(1);
    await feed.stop();

    expect(server.standby.at(-1)?.position).toBe(0xa100n);
    expect(server.closed).toBe(true);
  });
});
