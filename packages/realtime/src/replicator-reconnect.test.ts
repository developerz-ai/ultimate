// A database restart must cost the live windows seconds, not a minute. The demo took ~73 s to
// reconnect after one: every redial while the server was down grew the takeover backoff toward its
// 30 s cap, so the server came back and the replicator was still asleep. A connection the server
// ended (57P01/57P02/57P03) or the network reset is redialled at once, then on a curve capped low.

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
import { changeFeedReplicator, STOP_DEADLINE_MS } from './replicator';
import { connectionLost, REPLICATOR_RECONNECT_MAX_MS } from './replicator-reconnect';
import { manual, stubLock } from './replicator-rig-fixture';

const turns = async (count = 400): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) await Promise.resolve();
};

/** A lock session past its handshake that answers the one lock query with granted. */
const lockSession = (): FakeStream => {
  const stream = new FakeStream();
  stream.push(authOk(), readyForQuery());
  stream.push(dataRow('t'), commandComplete('SELECT 1'), readyForQuery());
  return stream;
};

/** What Bun's `connect` rejects with while nothing listens: a plain Error carrying `code`. */
const refused = (): Error =>
  Object.assign(new Error('Failed to connect'), { code: 'ECONNREFUSED' });

/** The top of every jitter range: the curve that waits longest is the one being measured. */
const worst = (): number => 0.999_999;

describe('the database restarts under a running replicator', () => {
  test('the backend is terminated (57P01): the replicator dials again with no wait', async () => {
    ensurePostsEntity();
    const sessions = [lockSession(), lockSession()];
    let lockDials = 0;
    const walsenders: FakeWalsender[] = [];
    const feed = feedOver(() => {
      // The second walsender finds the slot still held by the backend on its way out: the
      // preflight's slot-release wait stays in front of START_REPLICATION.
      const server = new FakeWalsender(walsenders.length === 0 ? {} : { slotHeldFor: 2 });
      walsenders.push(server);
      return Promise.resolve(server);
    });
    const lock = postgresAdvisoryLock({
      url: 'postgres://repluser:hunter2@localhost:5432/app?sslmode=disable',
      key: 'x:replicator:restart',
      stream: () => {
        const session = sessions[lockDials];
        lockDials += 1;
        if (session === undefined) return expect.unreachable('an unscripted lock dial');
        return Promise.resolve(session);
      },
    });
    // Timers held by hand: the claim is the WAIT the replicator asks for, never a wall-clock race.
    const timers = manual();
    const replicator = changeFeedReplicator({
      feed,
      lock,
      transport: new InProcessTransport(),
      schedule: timers.schedule,
      rng: worst,
    });
    expect(await replicator.start()).toBe(true);

    sessions[0]?.push(
      errorResponse({
        S: 'FATAL',
        C: '57P01',
        M: 'terminating connection due to administrator command',
      }),
    );
    sessions[0]?.end();
    await turns();
    expect(replicator.running).toBe(false);
    expect(replicator.stats().failure).toContain('57P01');
    // Once the redial is due, at once: the old curve asked for up to 500 ms here, then 30 s.
    expect(timers.delays).toEqual([0]);

    timers.fire();
    await turns(2_000);
    expect(replicator.running).toBe(true);
    expect(walsenders).toHaveLength(2);
    expect(walsenders[1]?.queries.some((sql) => sql.includes('pg_sleep'))).toBe(true);
    const stopping = replicator.stop();
    await turns();
    sessions[1]?.push(dataRow('t'), commandComplete('SELECT 1'), readyForQuery());
    await stopping;
  });

  test('the database stays down: every redial waits seconds at most, and the first none', async () => {
    ensurePostsEntity();
    let down = true;
    let dials = 0;
    const feed = feedOver(() => {
      dials += 1;
      return Promise.resolve(new FakeWalsender());
    });
    const lock = stubLock();
    const acquire = lock.tryAcquire;
    // The lock is dialled first, so a server that is down refuses the lock session.
    lock.tryAcquire = () => (down ? Promise.reject(refused()) : acquire());
    const timers = manual();
    const replicator = changeFeedReplicator({
      feed,
      lock,
      transport: new InProcessTransport(),
      schedule: timers.schedule,
      rng: worst,
    });
    down = false;
    expect(await replicator.start()).toBe(true);
    down = true;

    lock.lose('postgres replication idle failed: 57P01 — terminating connection');
    await turns();
    for (let round = 0; round < 12; round += 1) {
      timers.fire();
      await turns();
    }
    expect(replicator.running).toBe(false);
    const waits = timers.delays.filter((ms) => ms !== STOP_DEADLINE_MS);
    expect(waits).toHaveLength(13);
    expect(waits[0]).toBe(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(REPLICATOR_RECONNECT_MAX_MS);

    down = false;
    timers.fire();
    await turns();
    expect(replicator.running).toBe(true);
    expect(dials).toBe(2);
    await replicator.stop();
  });
});

describe('connectionLost', () => {
  test.each([
    ['57P01 admin shutdown', 'postgres replication stream failed: 57P01 — terminating connection'],
    ['57P02 crash shutdown', 'postgres replication idle failed: 57P02 — crash of another server'],
    [
      '57P03 starting up',
      'postgres replication startup failed: 57P03 — the database system is starting up',
    ],
    ['a reset socket', 'read ECONNRESET'],
    ['a refused dial', 'connect ECONNREFUSED 127.0.0.1:5432'],
    ['a lost lock session', 'the advisory lock was lost: the server closed the connection'],
    [
      'a dial that found no host',
      'postgres replication connect failed: Failed to connect — no route',
    ],
  ])('%s is a connection the server or the network ended', (_name, reason) => {
    expect(connectionLost(reason)).toBe(true);
  });

  test('reads the code a socket error carries, not only its message', () => {
    expect(connectionLost(refused())).toBe(true);
    expect(connectionLost(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(true);
  });

  test.each([
    ['a refused publish', 'payload exceeds max_payload'],
    ['an undecodable stream', 'X_REPLICATION_PROTOCOL: postgres replication decode: unknown tag'],
    ['a privilege the role lacks', 'postgres replication query failed: 42501 — must be owner'],
    ['a code that merely contains the digits', 'lsn 0/57P01AB'],
  ])('%s keeps the long curve', (_name, reason) => {
    expect(connectionLost(reason)).toBe(false);
  });
});
