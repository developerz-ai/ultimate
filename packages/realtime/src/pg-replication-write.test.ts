// The write a transaction is, read off the WAL: `@ultimat3/entity`'s Postgres driver opens a keyed
// write's transaction with a `pg_logical_emit_message`, and every change of THAT transaction — and
// of no other — names it. What a channel stamps on its `records` frame so the writing page can tell
// its own echo from somebody else's change.

import { describe, expect, test } from 'bun:test';
import { WRITE_ORIGIN_WAL_PREFIX } from '@ultimat3/core';
import {
  begin,
  commit,
  insert,
  logicalMessage,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  start,
  xlog,
} from './pg-replication-fixture';

const DIGEST = 'a'.repeat(32);
const row = (id: string): (string | null)[] => [id, 'Hello', 'org-1', '1990', 'USD', null];

describe('a keyed write, read off the WAL', () => {
  test('START_REPLICATION asks pgoutput for logical messages', async () => {
    const { server, feed } = await start();
    const started = server.queries.find((sql) => sql.startsWith('START_REPLICATION'));
    expect(started).toContain("messages 'true'");
    await feed.stop();
  });

  test('every change of the transaction the message opens names the write; the next one does not', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x1000n, 0n, 42)));
    server.push(xlog(logicalMessage(WRITE_ORIGIN_WAL_PREFIX, DIGEST)));
    server.push(xlog(insert(POSTS_OID, row('p1'))));
    server.push(xlog(insert(POSTS_OID, row('p2'))));
    server.push(xlog(commit(0x1000n, 0x1010n, 0n)));
    server.push(xlog(begin(0x2000n, 0n, 43)));
    server.push(xlog(insert(POSTS_OID, row('p3'))));
    server.push(xlog(commit(0x2000n, 0x2010n, 0n)));
    await settled(3);

    expect(events.map((event) => event.write)).toEqual([DIGEST, DIGEST, undefined]);
    expect(Object.hasOwn(events[2] ?? {}, 'write')).toBe(false);
    await feed.stop();
  });

  test('a message that is not the write origin names nothing', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    const cases = [
      logicalMessage(WRITE_ORIGIN_WAL_PREFIX, DIGEST, false),
      logicalMessage('some.extension', DIGEST),
      logicalMessage(WRITE_ORIGIN_WAL_PREFIX, 'likePost:the-raw-key'),
    ];
    let position = 0x1000n;
    for (const [index, message] of cases.entries()) {
      server.push(xlog(begin(position, 0n, index)));
      server.push(xlog(message));
      server.push(xlog(insert(POSTS_OID, row(`p${index}`))));
      server.push(xlog(commit(position, position + 0x10n, 0n)));
      position += 0x1000n;
    }
    await settled(3);

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.write)).toEqual([undefined, undefined, undefined]);
    await feed.stop();
  });
});
