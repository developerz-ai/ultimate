// A TRUNCATE off the WAL. It was decoded and dropped, so with the recommended `FOR ALL TABLES`
// publication every window and every client kept the truncated rows. Now one rowless `truncate`
// change per SELECTED relation, at its own lsn inside the transaction.

import { describe, expect, test } from 'bun:test';
import {
  begin,
  commit,
  OTHER_OID,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  start,
  truncate,
  xlog,
} from './pg-replication-fixture';

describe('a truncate, read off the WAL', () => {
  test('one rowless truncate change per selected relation, and none for the rest', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'id', key: true }])));
    server.push(xlog(begin(0x1000n, 0n, 7)));
    server.push(xlog(truncate([POSTS_OID, OTHER_OID])));
    server.push(xlog(commit(0x1000n, 0x1010n, 0n)));
    await settled(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity: 'posts', op: 'truncate', before: null, after: null });
    expect(events[0]?.lsn).not.toBe('');
    await feed.stop();
  });
});
