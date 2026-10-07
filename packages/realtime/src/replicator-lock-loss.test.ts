// The advisory lock IS a Postgres session. If that session dies while the replication stream stays
// up, Postgres hands the lock to whoever asks next — and this process went on streaming: two
// replicators on one database, every change published twice. Losing the lock ends the stream.

import { describe, expect, test } from 'bun:test';
import { InProcessTransport } from './fanout';
import { postgresAdvisoryLock } from './pg-advisory-lock';
import {
  authOk,
  commandComplete,
  dataRow,
  errorResponse,
  FakeStream,
  readyForQuery,
} from './pg-connection-fixture';
import { ensurePostsEntity, FakeWalsender, feedOver } from './pg-replication-fixture';
import { createReplicator } from './replicator';
import type { Scheduler } from './thundering-herd';

const turns = async (count = 400): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) await Promise.resolve();
};

/** A lock session past its handshake that answers the one lock query with `granted`. */
const lockSession = (granted: 't' | 'f' = 't'): FakeStream => {
  const stream = new FakeStream();
  stream.push(authOk(), readyForQuery());
  stream.push(dataRow(granted), commandComplete('SELECT 1'), readyForQuery());
  return stream;
};

const rig = (sessions: FakeStream[]) => {
  ensurePostsEntity();
  const walsenders: FakeWalsender[] = [];
  const feed = feedOver(() => {
    const server = new FakeWalsender();
    walsenders.push(server);
    return Promise.resolve(server);
  });
  let lockDials = 0;
  const lock = postgresAdvisoryLock({
    url: 'postgres://repluser:hunter2@localhost:5432/app?sslmode=disable',
    key: 'x:replicator:watched',
    stream: () => {
      const session = sessions[lockDials];
      lockDials += 1;
      if (session === undefined) return expect.unreachable('an unscripted lock dial');
      return Promise.resolve(session);
    },
  });
  const pending: (() => void)[] = [];
  const schedule: Scheduler = (fn) => {
    pending.push(fn);
    return () => undefined;
  };
  const replicator = createReplicator({
    feed,
    lock,
    transport: new InProcessTransport(),
    schedule,
    backoff: { baseMs: 100, maxMs: 1_000, factor: 2, jitter: 'none' },
  });
  return {
    walsenders,
    replicator,
    lockDials: () => lockDials,
    fire: () => {
      for (const fn of pending.splice(0)) fn();
    },
  };
};

/** `stop()` unlocks with a statement; the scripted session answers it once it has been asked. */
const stopAnswering = async (
  replicator: { stop(): Promise<void> },
  session: FakeStream,
): Promise<void> => {
  const stopping = replicator.stop();
  await turns();
  session.push(dataRow('t'), commandComplete('SELECT 1'), readyForQuery());
  await stopping;
};

describe('the lock session dies under a running replicator', () => {
  for (const [how, kill] of [
    ['the socket closes', (session: FakeStream) => session.end()],
    [
      'the backend is terminated',
      (session: FakeStream) => {
        session.push(
          errorResponse({
            S: 'FATAL',
            C: '57P01',
            M: 'terminating connection due to administrator command',
          }),
        );
        session.end();
      },
    ],
  ] as const) {
    test(`${how}: the stream is ended, and the replicator competes for the lock again`, async () => {
      const first = lockSession();
      const second = lockSession();
      const { walsenders, replicator, lockDials, fire } = rig([first, second]);
      expect(await replicator.start()).toBe(true);
      expect(walsenders[0]?.closed).toBe(false);

      kill(first);
      await turns();

      // Not running, and — the point — not streaming: the walsender connection is closed.
      expect(replicator.running).toBe(false);
      expect(walsenders[0]?.closed).toBe(true);
      expect(replicator.stats().failure).toContain('advisory lock');
      expect(first.closed).toBe(true);
      expect(lockDials()).toBe(1);

      fire();
      await turns();
      expect(lockDials()).toBe(2);
      expect(walsenders).toHaveLength(2);
      expect(replicator.running).toBe(true);
      await stopAnswering(replicator, second);
    });
  }

  test('another process took the lock meanwhile: this one is a standby until it gets it back', async () => {
    const first = lockSession();
    const third = lockSession();
    const { walsenders, replicator, lockDials, fire } = rig([first, lockSession('f'), third]);
    await replicator.start();
    first.end();
    await turns();

    fire();
    await turns();
    // Asked the database, was told no: not running, and no second stream beside the holder's.
    expect(lockDials()).toBe(2);
    expect(replicator.running).toBe(false);
    expect(walsenders).toHaveLength(1);

    fire();
    await turns();
    expect(lockDials()).toBe(3);
    expect(replicator.running).toBe(true);
    expect(walsenders).toHaveLength(2);
    await stopAnswering(replicator, third);
  });

  test('a release is not a loss: stop() arms no restart and records no failure', async () => {
    const first = lockSession();
    const { replicator, lockDials, fire } = rig([first]);
    await replicator.start();
    await stopAnswering(replicator, first);
    await turns();
    fire();
    await turns();

    expect(first.closed).toBe(true);
    expect(replicator.stats().failure).toBeNull();
    expect(replicator.running).toBe(false);
    expect(lockDials()).toBe(1);
  });
});
