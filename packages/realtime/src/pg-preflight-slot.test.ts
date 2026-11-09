// The slot question at preflight, and the two answers that used to be silent: a slot postgres
// INVALIDATED (`wal_status = 'lost'`) failed every restart generically; a slot that was GONE under
// a resume position was recreated quietly, the changes in between lost, quiet tables stale forever.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { errorResponse } from './pg-connection-fixture';
import {
  begin,
  commit,
  ensurePostsEntity,
  FakeWalsender,
  feedOver,
  insert,
  joined,
  POST_COLUMNS,
  POSTS_OID,
  ready,
  relation,
  type ServerScript,
  xlog,
} from './pg-replication-fixture';

/** A resume position well past anything the new slot will stream. */
const FROM = `${0x9000n.toString(16).padStart(16, '0')}00000001`;

let restore = (): void => undefined;
afterEach(() => restore());

const boot = async (script: ServerScript, from?: string) => {
  ensurePostsEntity();
  const server = new FakeWalsender(script);
  const feed = feedOver(() => Promise.resolve(server), { fullIdentityTables: [] });
  const events: ChangeEvent[] = [];
  const resyncs: string[] = [];
  const warn = spyOn(logger, 'warn');
  restore = () => warn.mockRestore();
  const started = feed.start({
    ...(from === undefined ? {} : { from }),
    onChange: (event) => void events.push(event),
    onResync: (reason) => resyncs.push(reason),
  });
  return { server, feed, events, resyncs, warn, started };
};

test('the slot question asks its wal_status, in the same statement', async () => {
  const { server, feed, started } = await boot({});
  await started;
  await feed.stop();
  const question = server.queries.find((sql) => sql.includes('pg_replication_slots')) ?? '';
  expect(question).toContain('wal_status');
});

test('an invalidated slot is refused with its own code and the statement that drops it', async () => {
  const { server, started } = await boot({ slotWalStatus: 'lost' }, FROM);
  const failure = await started.then(
    () => expect.unreachable('an invalidated slot must not stream'),
    (error: unknown) => error as { code?: string; fix?: string },
  );
  expect(failure.code).toBe('X_REPLICATION_SLOT_INVALIDATED');
  expect(failure.fix).toStartWith("SELECT pg_drop_replication_slot('ultimate_slot');");
  expect(server.queries.some((sql) => sql.startsWith('START_REPLICATION'))).toBe(false);
  expect(server.closed).toBe(true);
});

test('a slot gone under a resume position is said, resynced, and streamed from its start', async () => {
  const { server, feed, events, resyncs, warn, started } = await boot({ slotPlugin: null }, FROM);
  await started;

  const line = warn.mock.calls.find((call) => call[0] === 'X_REPLICATION_SLOT_RECREATED');
  expect(String(line?.[1]?.['cause'])).toContain(FROM);
  expect(resyncs).toHaveLength(1);
  expect(resyncs[0]).toContain('recreated');
  // The old position names a slot that no longer exists: the new one starts where IT starts.
  const started_ = server.queries.find((sql) => sql.startsWith('START_REPLICATION')) ?? '';
  expect(started_).toContain('LOGICAL 0/0');

  // A change below the old position is NEW on the new slot (another server's WAL, after a
  // failover), never a replay to drop.
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
  server.push(xlog(insert(POSTS_OID, ['p1', 't', 'o1', null, null, null])));
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  for (let tick = 0; tick < 200 && events.length === 0; tick += 1) await Promise.resolve();
  expect(events).toHaveLength(1);
  expect(feed.stats().replayed).toBe(0);
  await feed.stop();
});

test('a first boot creating its slot, and a resume onto a slot that is there, resync nothing', async () => {
  const fresh = await boot({ slotPlugin: null });
  await fresh.started;
  await fresh.feed.stop();
  expect(fresh.resyncs).toEqual([]);
  expect(fresh.warn.mock.calls.some((call) => call[0] === 'X_REPLICATION_SLOT_RECREATED')).toBe(
    false,
  );
  restore();

  const resumed = await boot({}, FROM);
  await resumed.started;
  await resumed.feed.stop();
  expect(resumed.resyncs).toEqual([]);
});

/** Creates the slot as asked, then refuses START_REPLICATION — a dial that dies half way. */
class StartRefusingWalsender extends FakeWalsender {
  override write(bytes: Uint8Array): Promise<void> {
    if (bytes[0] === 0x51 && new TextDecoder().decode(bytes).includes('START_REPLICATION')) {
      this.queries.push('START_REPLICATION (refused)');
      this.push(joined(errorResponse({ C: '57P01', M: 'terminating connection' }), ready()));
      return Promise.resolve();
    }
    return super.write(bytes);
  }
}

// The slot was created by a dial that then failed: the retry finds it EXISTING. The gap is no
// smaller for that — the creation is carried on the stream until a dial gets through.
test('a slot created by a dial that then failed is still a gap on the retry', async () => {
  ensurePostsEntity();
  const second = new FakeWalsender();
  const servers: FakeWalsender[] = [new StartRefusingWalsender({ slotPlugin: null }), second];
  const feed = feedOver(() => Promise.resolve(servers.shift() ?? new FakeWalsender()), {
    fullIdentityTables: [],
  });
  const resyncs: string[] = [];
  const handlers = {
    from: FROM,
    onChange: () => undefined,
    onResync: (reason: string) => void resyncs.push(reason),
  };
  const failed = await feed.start(handlers).then(
    () => 'started',
    () => 'failed',
  );
  expect(failed).toBe('failed');

  await feed.start(handlers);
  expect(resyncs).toHaveLength(1);
  const started = second.queries.find((sql) => sql.startsWith('START_REPLICATION')) ?? '';
  expect(started).toContain('LOGICAL 0/0');
  await feed.stop();

  // Said once: the dial after that one is continuous again.
  await feed.start(handlers);
  expect(resyncs).toHaveLength(1);
  await feed.stop();
});
