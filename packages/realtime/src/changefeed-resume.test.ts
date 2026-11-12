// What a feed says about where it stands: `onResume` — every change above this will be delivered —
// and `position()` — every change at or below this has been. A claim a feed cannot keep is a lost
// change no sync node notices, so each "says nothing" case is pinned beside each "says".

import { describe, expect, test } from 'bun:test';
import { formatLsn, memoryChangeFeed } from './changefeed';
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
  type ServerScript,
  xlog,
} from './pg-replication-fixture';
import { changeLsn } from './pg-replication-position';

describe('memory feed', () => {
  test('a resume inside the retained window is claimed; a from-now start claims nothing', async () => {
    const feed = memoryChangeFeed();
    const said: string[] = [];
    await feed.start({ onChange: () => undefined, onResume: (at) => said.push(at) });
    await feed.push('posts', 'insert', { after: { id: 'p1' } });
    expect(said).toEqual([]);
    expect(feed.position()).toBe(formatLsn(1));
    await feed.stop();
    await feed.start({
      from: formatLsn(1),
      onChange: () => undefined,
      onResume: (at) => said.push(at),
    });
    expect(said).toEqual([formatLsn(1)]);
  });

  test('a resume below what retention let go of is not claimed: those changes are gone', async () => {
    const feed = memoryChangeFeed({ retain: 1 });
    await feed.push('posts', 'insert', { after: { id: 'p1' } });
    await feed.push('posts', 'insert', { after: { id: 'p2' } });
    const said: string[] = [];
    await feed.start({
      from: formatLsn(0),
      onChange: () => undefined,
      onResume: (at) => said.push(at),
    });
    expect(said).toEqual([]);
    await feed.stop();
    await feed.start({
      from: formatLsn(1),
      onChange: () => undefined,
      onResume: (at) => said.push(at),
    });
    expect(said).toEqual([formatLsn(1)]);
  });
});

describe('postgres feed', () => {
  const started = async (script: ServerScript, from?: string) => {
    ensurePostsEntity();
    const server = new FakeWalsender(script);
    const feed = feedOver(() => Promise.resolve(server), { fullIdentityTables: [] });
    const said: string[] = [];
    await feed.start({
      ...(from === undefined ? {} : { from }),
      onChange: () => undefined,
      onResume: (at) => said.push(at),
    });
    return { server, feed, said };
  };

  test('an existing slot resumes at its confirmed position, and says so', async () => {
    const { server, feed, said } = await started({ slotConfirmed: '0/6000' });
    expect(server.queries.find((sql) => sql.startsWith('START_REPLICATION'))).toContain(
      'LOGICAL 0/6000',
    );
    expect(said).toEqual([changeLsn(0x6000n, 0)]);
    expect(feed.position()).toBe(changeLsn(0x6000n, 0));
    await feed.stop();
  });

  test('a new slot says nothing: what came before it was never streamed', async () => {
    const { feed, said } = await started({ slotPlugin: null, slotConfirmed: '0/6000' });
    expect(said).toEqual([]);
    expect(feed.position()).toBeNull();
    await feed.stop();
  });

  test('a resume position is claimed as given', async () => {
    const { feed, said } = await started({}, changeLsn(0x5000n, 2));
    expect(said).toEqual([changeLsn(0x5000n, 2)]);
    await feed.stop();
  });

  test('position() rises with each commit the stream confirms', async () => {
    const { server, feed } = await started({ slotConfirmed: '0/6000' });
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x7000n, 0n, 9)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', 'org-1', null, null, null])));
    server.push(xlog(commit(0x7000n, 0x7040n, 0n)));
    for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
    expect(feed.position()).toBe(changeLsn(0x7040n, 0));
    await feed.stop();
  });
});
