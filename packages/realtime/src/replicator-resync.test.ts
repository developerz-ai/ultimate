// A replication slot recreated under a resume position (plan 101 R3): the changes committed in
// between were never streamed, and no sequence can show a hole the replicator itself never saw.
// The replicator SAYS it on the bus, before any change of the new stream, until it is heard.

import { expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { memoryAdvisoryLock } from './advisory-lock';
import { type ChangeFeedStartOptions, MemoryChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import { parseResync, RESYNC_SUBJECT } from './replication-resync';
import { CHANGE_SUBJECT_ALL, changeFeedReplicator } from './replicator';
import { parseEnvelope } from './replicator-envelope';

/** The memory feed, as the Postgres one behaves when preflight had to create the slot. */
class RecreatedFeed extends MemoryChangeFeed {
  override async start(options: ChangeFeedStartOptions): Promise<void> {
    await super.start(options);
    options.onResync?.('replication slot "s" was recreated under resume position 00ff');
  }
}

const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
};

test('a recreated slot is said on the bus at once, by this run, before its first change', async () => {
  const transport = new InProcessTransport();
  const heard: string[] = [];
  await transport.subscribe(CHANGE_SUBJECT_ALL, (payload) => void heard.push(payload));
  const feed = new RecreatedFeed();
  const replicator = changeFeedReplicator({ feed, transport, lock: memoryAdvisoryLock('x:rs:1') });
  expect(await replicator.start()).toBe(true);
  await turns();

  // On a quiet database: no change follows, and the readers still re-read now.
  expect(heard).toHaveLength(1);
  const said = parseResync(heard[0] ?? '');
  expect(said?.reason).toContain('recreated');
  await feed.push('posts', 'insert', { after: { id: 'p1' }, orgId: 'o1' });
  // Said once: the change after it is an ordinary one, and it is no resync.
  expect(heard).toHaveLength(2);
  expect(parseResync(heard[1] ?? '')).toBeNull();
  expect(parseEnvelope(heard[1] ?? '')?.producer).toBe(said?.producer as string);
  await replicator.stop();
});

test('a resync the bus refused is owed, and goes out before the next change', async () => {
  const transport = new InProcessTransport();
  const heard: string[] = [];
  await transport.subscribe(CHANGE_SUBJECT_ALL, (payload) => void heard.push(payload));
  let refuse = true;
  const publish = transport.publish.bind(transport);
  // The bus refusing the publish is the test's INPUT: a rejection handed to the replicator.
  const spy = spyOn(transport, 'publish').mockImplementation((subject, payload) => {
    if (subject === RESYNC_SUBJECT && refuse) {
      refuse = false;
      return Promise.reject(new TypeError('payload refused'));
    }
    return publish(subject, payload);
  });
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const feed = new RecreatedFeed();
  const replicator = changeFeedReplicator({ feed, transport, lock: memoryAdvisoryLock('x:rs:2') });
  try {
    expect(await replicator.start()).toBe(true);
    await turns();
    expect(heard).toEqual([]);
    expect(warn).toHaveBeenCalledWith('replicator.resync_unpublished', expect.anything());

    await feed.push('posts', 'insert', { after: { id: 'p1' }, orgId: 'o1' });
    expect(heard.map((payload) => (parseResync(payload) === null ? 'change' : 'resync'))).toEqual([
      'resync',
      'change',
    ]);
  } finally {
    spy.mockRestore();
    warn.mockRestore();
    await replicator.stop();
  }
});

test('the resync subject is under every node subscription, and is no table', () => {
  expect(RESYNC_SUBJECT.startsWith(CHANGE_SUBJECT_ALL.slice(0, -1))).toBe(true);
  // Not `[a-z_][a-z0-9_]*`: no entity table can ever be published on it.
  expect(/^[a-z_][a-z0-9_]*$/.test(RESYNC_SUBJECT.split('.')[2] ?? '')).toBe(false);
  // And a change envelope is never read as one.
  expect(parseResync('{"table":"posts","lsn":"1"}')).toBeNull();
});
