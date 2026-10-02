// A replication stream that ends is restarted, and until it is the replicator says it is not
// running. The stream used to record its death in `stats().failure`, which nothing read: `running`
// stayed `true`, the advisory lock stayed held, and every live window in the fleet froze on its
// last snapshot until somebody restarted the pod.

import { describe, expect, test } from 'bun:test';
import type { AdvisoryLock } from './advisory-lock';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import {
  begin,
  commit,
  copyDone,
  ensurePostsEntity,
  FakeWalsender,
  feedOver,
  insert,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  xlog,
} from './pg-replication-fixture';
import { createReplicator, STOP_DEADLINE_MS } from './replicator';
import { parseChange } from './replicator-envelope';
import type { Scheduler } from './thundering-herd';

/** A lock that counts, with the await a real session has between being asked and answering. */
const countingLock = (): AdvisoryLock & {
  acquired: number;
  released: number;
  abandoned: number;
  held: boolean;
} => {
  const lock = {
    key: 'x:replicator:supervised',
    acquired: 0,
    released: 0,
    abandoned: 0,
    held: false,
    tryAcquire: async (): Promise<boolean> => {
      await Promise.resolve();
      lock.acquired += 1;
      lock.held = true;
      return true;
    },
    release: async (): Promise<void> => {
      lock.released += 1;
      lock.held = false;
    },
    abandon: (): void => {
      lock.abandoned += 1;
      lock.held = false;
    },
    onLost: () => () => undefined,
  };
  return lock;
};

/** Timers held by hand: a restart only provable by sleeping is a restart no test proves. */
const manualScheduler = (): { schedule: Scheduler; delays: number[]; fire(): void } => {
  const pending: (() => void)[] = [];
  const delays: number[] = [];
  return {
    delays,
    schedule: (fn, ms) => {
      // The unlock deadline rides the same seam; what these cases count is the RESTART waits.
      if (ms !== STOP_DEADLINE_MS) delays.push(ms);
      pending.push(fn);
      return () => {
        const at = pending.indexOf(fn);
        if (at >= 0) pending.splice(at, 1);
      };
    },
    fire: () => {
      for (const fn of pending.splice(0)) fn();
    },
  };
};

const turns = async (count = 400): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) await Promise.resolve();
};

/** One committed single-row transaction on `posts`, as the walsender frames it. */
const transaction = (server: FakeWalsender, lsn: bigint, id: string): void => {
  server.push(xlog(begin(lsn, 0n, Number(lsn))));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
  server.push(xlog(insert(POSTS_OID, [id, 'title', 'o1', null, null, null])));
  server.push(xlog(commit(lsn, lsn + 8n, 0n)));
};

const rig = (transport: Transport = new InProcessTransport()) => {
  ensurePostsEntity();
  const servers: FakeWalsender[] = [];
  const feed = feedOver(() => {
    const server = new FakeWalsender();
    servers.push(server);
    return Promise.resolve(server);
  });
  const lock = countingLock();
  const timers = manualScheduler();
  const replicator = createReplicator({
    feed,
    transport,
    lock,
    schedule: timers.schedule,
    backoff: { baseMs: 100, maxMs: 1_000, factor: 2, jitter: 'none' },
  });
  return { servers, feed, lock, timers, replicator };
};

describe('a replication stream that ends', () => {
  test('clears running, releases the lock and dials again after the backoff', async () => {
    const { servers, lock, timers, replicator } = rig();
    expect(await replicator.start()).toBe(true);
    expect(servers).toHaveLength(1);

    servers[0]?.push(copyDone());
    await turns();

    expect(replicator.running).toBe(false);
    expect(replicator.stats().failure).toContain('the walsender ended the copy stream');
    expect(lock.held).toBe(false);
    // Dropped, not asked: the lock's session may be what died, and an unlock on it never answers.
    expect(lock.abandoned).toBe(1);
    expect(lock.released).toBe(0);
    // Nothing redials before the backoff: N standbys must not all take the slot back at once.
    expect(servers).toHaveLength(1);
    expect(timers.delays).toEqual([100]);

    timers.fire();
    await turns();

    expect(servers).toHaveLength(2);
    expect(lock.acquired).toBe(2);
    expect(replicator.running).toBe(true);
    expect(replicator.stats()).toMatchObject({ failure: null, restarts: 1 });
    await replicator.stop();
  });

  test('one rejected publish restarts the stream, and the change it refused is delivered', async () => {
    const published: string[] = [];
    let refuse = true;
    const inner = new InProcessTransport();
    const transport: Transport = {
      name: 'flaky',
      shared: inner.shared,
      subscribe: (subject, handler) => inner.subscribe(subject, handler),
      close: () => inner.close(),
      onReconnect: () => inner.onReconnect(),
      publish: async (_subject, payload) => {
        if (refuse) {
          refuse = false;
          // What a bus mid-reconnect answers: a foreign rejection, not one this package built.
          throw new TypeError('connection is reconnecting');
        }
        published.push(payload);
      },
    };
    const { servers, lock, timers, replicator } = rig(transport);
    await replicator.start();

    const first = servers[0];
    if (first === undefined) return expect.unreachable();
    transaction(first, 0x100n, 'p1');
    await turns();

    expect(published).toHaveLength(0);
    expect(replicator.running).toBe(false);
    expect(lock.held).toBe(false);

    timers.fire();
    await turns();
    // Connected again, and still not REPLICATING: the change it refused has not gone out.
    expect(replicator.running).toBe(false);
    expect(replicator.stats().failure).toContain('connection is reconnecting');
    expect(servers).toHaveLength(2);

    // The walsender restarts at the last CONFIRMED transaction boundary, so the refused one comes
    // again — and the one after it follows. Neither is lost and neither is doubled.
    const second = servers[1];
    if (second === undefined) return expect.unreachable();
    transaction(second, 0x100n, 'p1');
    transaction(second, 0x200n, 'p2');
    await turns();

    expect(published.map((payload) => parseChange(payload)?.after?.id)).toEqual(['p1', 'p2']);
    expect(replicator.running).toBe(true);
    expect(replicator.stats()).toMatchObject({ published: 2, restarts: 1, failure: null });
    await replicator.stop();
  });

  test('a restart that fails is retried on a longer delay, and stop ends the loop', async () => {
    ensurePostsEntity();
    let dials = 0;
    const servers: FakeWalsender[] = [];
    const feed = feedOver(() => {
      dials += 1;
      // The second and third dials find no database at all: a failover still in progress.
      if (dials === 2 || dials === 3) return Promise.reject(new TypeError('ECONNREFUSED'));
      const server = new FakeWalsender();
      servers.push(server);
      return Promise.resolve(server);
    });
    const lock = countingLock();
    const timers = manualScheduler();
    const replicator = createReplicator({
      feed,
      lock,
      transport: new InProcessTransport(),
      schedule: timers.schedule,
      backoff: { baseMs: 100, maxMs: 1_000, factor: 2, jitter: 'none' },
    });
    await replicator.start();
    servers[0]?.push(copyDone());
    await turns();

    timers.fire();
    await turns();
    expect(replicator.running).toBe(false);
    expect(replicator.stats().failure).toContain('ECONNREFUSED');
    // A failed restart holds nothing: a standby must be able to take the slot meanwhile.
    expect(lock.held).toBe(false);

    timers.fire();
    await turns();
    expect(timers.delays).toEqual([100, 200, 400]);

    timers.fire();
    await turns();
    expect(replicator.running).toBe(true);
    expect(dials).toBe(4);

    servers[1]?.push(copyDone());
    await turns();
    // A stream that came back is not progress — only a published change is. Nothing was
    // published, so the wait keeps growing rather than redialling at the base forever.
    expect(timers.delays).toEqual([100, 200, 400, 800]);

    await replicator.stop();
    timers.fire();
    await turns();
    expect(dials).toBe(4);
    expect(replicator.running).toBe(false);
    expect(lock.held).toBe(false);
  });

  test('a stream that ends after stop() restarts nothing', async () => {
    const { servers, timers, replicator } = rig();
    await replicator.start();
    await replicator.stop();
    servers[0]?.push(copyDone());
    await turns();
    expect(timers.delays).toEqual([]);
    expect(servers).toHaveLength(1);
  });
});
