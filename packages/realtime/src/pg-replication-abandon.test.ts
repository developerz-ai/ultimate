// `abandon()`: the stream goes silent without a word. `stop()` confirms, says `CopyDone` and
// `Terminate`; on a black-holed walsender each of those is a write nothing ever settles.

import { expect, test } from 'bun:test';
import type { ChangeEvent } from './changefeed';
import {
  begin,
  commit,
  ensurePostsEntity,
  FakeWalsender,
  feedOver,
  insert,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  xlog,
} from './pg-replication-fixture';

/** A walsender that counts what the client wrote to it, and never answers a goodbye. */
class CountingWalsender extends FakeWalsender {
  writes = 0;
  override write(bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    return super.write(bytes);
  }
}

const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 300; tick += 1) await Promise.resolve();
};

test('abandon closes the socket, writes nothing, announces nothing, and delivers nothing after', async () => {
  ensurePostsEntity();
  const servers: CountingWalsender[] = [];
  const feed = feedOver(() => {
    const server = new CountingWalsender();
    servers.push(server);
    return Promise.resolve(server);
  });
  const events: ChangeEvent[] = [];
  const ends: string[] = [];
  await feed.start({
    onChange: (event) => void events.push(event),
    onEnd: (reason) => ends.push(reason),
  });
  const server = servers[0];
  if (server === undefined) return expect.unreachable();
  const written = server.writes;

  feed.abandon();

  expect(server.closed).toBe(true);
  expect(server.writes).toBe(written);
  // A transaction the socket still held when it was dropped reaches nobody.
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
  server.push(xlog(insert(POSTS_OID, ['p1', 't', 'o1', null, null, null])));
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  await turns();
  expect(events).toEqual([]);
  // Letting go on purpose is not the stream ending on its own.
  expect(ends).toEqual([]);
  expect(feed.stats().failure).toBeNull();

  // And the feed can be started again: the abandoned pump is not something `start()` waits on forever.
  await feed.start({ onChange: () => undefined });
  expect(servers).toHaveLength(2);
  await feed.stop();
});
