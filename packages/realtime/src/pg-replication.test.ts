import { describe, expect, jest, test } from 'bun:test';
import { bigint, entity, entityForTable, text } from '@ultimat3/entity';
import { pgTimestampToEpochMs } from './pg-bytes';
import { changeLsn, commitPositionOf } from './pg-replication';
import {
  begin,
  commit,
  type FixtureColumn,
  INT8,
  insert,
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
      table: 'posts',
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
      write: null,
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
    server.push(xlog(insert(POSTS_OID, ['p9', 't', 'org-9', null, null, null])));
    server.push(xlog(commit(0x3000n, 0x3100n, 0n)));
    await settled(1);

    expect(events).toHaveLength(1);
    // Position 2, not 1: narrowing the entity list must not renumber the stream.
    expect(events[0]?.lsn).toBe(changeLsn(0x3000n, 2));
    expect(events[0]?.orgId).toBe('org-9');
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
    // The default identity is what sends a key-only old tuple, so the relation says so.
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'd')));
    server.push(xlog(remove(POSTS_OID, ['p1', null, null, null, null, null])));
    server.push(xlog(commit(0x4000n, 0x4100n, 0n)));
    await settled(2);

    expect(events[0]?.op).toBe('update');
    expect(events[0]?.before?.['title']).toBe('Old');
    expect(events[0]?.after?.['title']).toBe('New');
    expect(events[1]?.op).toBe('delete');
    // A key-only identity nulls the non-key columns, and those NULLs are not the row's values: the
    // image decodes as the key alone, never as a row claiming a null title and a null tenant.
    expect(events[1]?.before).toEqual({ id: 'p1' });
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
    server.push(xlog(update(POSTS_OID, null, ['p1', 'New', 'org-1', null, null, null])));
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
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', 'org-1', null, null, null])));
    }
    server.push(xlog(commit(0x6000n, 0x6100n, 0n)));
    await settled(2);

    expect(events.map((event) => event.after?.['id'])).toEqual(['p3', 'p4']);
    expect(feed.stats().replayed).toBe(2);
    expect(server.queries.find((sql) => sql.startsWith('START_REPLICATION'))).toContain(
      'LOGICAL 0/6000',
    );
    await feed.stop();
  });

  test('a replicated table with no text id is a loud configuration error', async () => {
    if (entityForTable('audit_log') === undefined) {
      entity('audit_log', { columns: { seq: bigint().primaryKey() } });
    }
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
    // `bigint()` is the entity's column for it, and its reader is what makes both ids text.
    if (entityForTable('ledger_rows') === undefined) {
      entity('ledger_rows', { columns: { id: bigint().primaryKey(), title: text() } });
    }
    const { server, events, settled, feed } = await start({ entities: ['ledger_rows'] });
    server.push(xlog(relation(POSTS_OID, 'ledger_rows', columns)));
    server.push(xlog(begin(0xb000n, 0n, 21)));
    server.push(xlog(insert(POSTS_OID, ['42', 'small'])));
    server.push(xlog(insert(POSTS_OID, ['9223372036854775807', 'large'])));
    server.push(xlog(commit(0xb000n, 0xb100n, 0n)));
    await settled(2);

    // A safe int8 decodes as a number and a large one as text; `LiveRow.id` is text either way, or
    // the same table would identify small rows by number and large rows by string.
    expect(events.map((event) => event.after?.['id'])).toEqual(['42', '9223372036854775807']);
    await feed.stop();
  });

  test('the confirm timer stops with the pump it confirms for', async () => {
    // The interval is a real `setInterval` on Bun's fake timers: it fires when the test moves them.
    jest.useFakeTimers();
    try {
      const microtasks = async (): Promise<void> => {
        for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
      };
      const { server, feed } = await start({ entities: ['audit_log'], statusIntervalMs: 5 });
      // Alive, the timer confirms: three intervals are standby status updates on the wire.
      const idle = server.standby.length;
      jest.advanceTimersByTime(15);
      await microtasks();
      expect(server.standby.length).toBeGreaterThan(idle);

      server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'seq', key: true }])));
      server.push(xlog(begin(0x7100n, 0n, 22)));
      server.push(xlog(insert(OTHER_OID, ['1'])));
      await microtasks();
      expect(feed.stats().failure).not.toBeNull();
      const confirmations = server.standby.length;
      jest.advanceTimersByTime(30);
      await microtasks();

      // A dead loop must stop telling the walsender it is keeping up.
      expect(server.standby.length).toBe(confirmations);
      await feed.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
