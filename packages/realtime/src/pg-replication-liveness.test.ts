// A walsender that stopped answering is a dead stream, even when no write ever fails.
//
// A half-open socket — a failover that moved the IP, a NAT table that dropped the flow — accepts
// every write and delivers nothing. The stream was declared dead only when a write REJECTED, never
// asked the walsender for a reply, and had no read deadline: nothing replicated for ~15 minutes
// (`tcp_retries2`) while `stats().failure` stayed null and `/readyz` stayed green.

import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import type { ChangeEvent } from './changefeed';
import {
  begin,
  commit,
  ensurePostsEntity,
  FakeWalsender,
  feedOver,
  insert,
  keepalive,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  xlog,
} from './pg-replication-fixture';

const COPY_DATA = 0x64;
const TERMINATE = 0x58;

/** Takes every write and answers none of them, and its goodbye never settles — a black hole. */
class SilentWalsender extends FakeWalsender {
  copyWrites = 0;
  terminated = false;
  #streaming = false;
  override write(bytes: Uint8Array): Promise<void> {
    if (bytes[0] === TERMINATE) {
      this.terminated = true;
      return new Promise<void>(() => undefined);
    }
    if (this.#streaming && bytes[0] === COPY_DATA) {
      this.copyWrites += 1;
      return Promise.resolve();
    }
    if (bytes[0] === 0x51 && new TextDecoder().decode(bytes).includes('START_REPLICATION')) {
      this.#streaming = true;
    }
    return super.write(bytes);
  }
}

/** Reads keep flowing, but a frontend CopyData write parks on a `drain` that never fires. */
class ParkedWriteWalsender extends FakeWalsender {
  parked = 0;
  #streaming = false;
  override write(bytes: Uint8Array): Promise<void> {
    if (this.#streaming && bytes[0] === COPY_DATA) {
      this.parked += 1;
      return new Promise<void>(() => undefined);
    }
    if (bytes[0] === 0x51 && new TextDecoder().decode(bytes).includes('START_REPLICATION')) {
      this.#streaming = true;
    }
    return super.write(bytes);
  }
}

// The status interval is a real `setInterval` on Bun's fake timers: it fires because the test
// moves them, one millisecond at a time, never because time went by.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

/** Let every settled promise run: the fakes answer on microtasks, never on a timer. */
const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 30; tick += 1) await Promise.resolve();
};

/** One status interval, then everything it set off. `each` runs first — a walsender talking. */
async function interval(each?: () => void): Promise<void> {
  each?.();
  jest.advanceTimersByTime(1);
  await turns();
}

/** Bounded: intervals elapsed by hand until `done`, or the test fails naming what never came. */
async function waitUntil(
  done: () => boolean,
  label: string,
  each?: () => void,
  intervals = 400,
): Promise<void> {
  for (let tick = 0; tick < intervals; tick += 1) {
    if (done()) return;
    await interval(each);
  }
  expect.unreachable(`timed out waiting for ${label}`);
}

test('the timer asks the walsender to answer, and an answering one is never declared dead', async () => {
  ensurePostsEntity();
  const server = new FakeWalsender();
  const feed = feedOver(() => Promise.resolve(server), { statusIntervalMs: 1 });
  await feed.start({ onChange: () => undefined });

  await waitUntil(() => server.standby.length >= 30, 'thirty status updates');
  // Thirty intervals is ten times the silence the stream tolerates: an answering walsender is live.
  expect(feed.stats().failure).toBeNull();
  expect(server.standby.every((update) => update.replyRequested === 1)).toBe(true);
  await feed.stop();
  // The goodbye confirm asks nothing: the stream is ending, an answer would arrive to nobody.
  expect(server.standby.at(-1)?.replyRequested).toBe(0);
});

test('a walsender that takes every write and answers none is a death, announced without a goodbye', async () => {
  ensurePostsEntity();
  const server = new SilentWalsender();
  const feed = feedOver(() => Promise.resolve(server), { statusIntervalMs: 1 });
  const ends: string[] = [];
  await feed.start({ onChange: () => undefined, onEnd: (reason) => ends.push(reason) });
  expect(feed.stats().failure).toBeNull();

  await waitUntil(() => ends.length > 0, 'onEnd');

  // Writes landed: the old detector, which counted only REJECTED writes, never fired here.
  expect(server.copyWrites).toBeGreaterThan(0);
  expect(feed.stats().confirmFailures).toBe(0);
  expect(feed.stats().failure).toContain('nothing from the walsender');
  expect(ends).toHaveLength(1);
  // Destroyed, not closed: a `Terminate` written into the black hole would have parked `#die`
  // before it reached `onEnd`, and the supervisor would never have heard.
  expect(server.terminated).toBe(false);
  expect(server.closed).toBe(true);
  await feed.stop();
});

test('a confirm that never settles is a failure per interval, and a run of them a death', async () => {
  ensurePostsEntity();
  const server = new ParkedWriteWalsender();
  const feed = feedOver(() => Promise.resolve(server), { statusIntervalMs: 1 });
  await feed.start({ onChange: () => undefined });
  // The walsender is talking — its own keepalive every interval — so silence is never what ends
  // this stream: only the write that never settles can.
  const chatter = (): void => server.push(keepalive(0n, 0));
  await waitUntil(() => feed.stats().failure !== null, 'the stream to record its failure', chatter);
  expect(feed.stats().failure).toContain('has not settled');
  expect(feed.stats().confirmFailures).toBeGreaterThanOrEqual(3);
  // One write parked; the ones behind it were never queued onto a chain that cannot move.
  expect(server.parked).toBe(1);
  await feed.stop();
});

test('a restart after a parked confirm confirms again: the dead chain is not inherited', async () => {
  ensurePostsEntity();
  const parked = new ParkedWriteWalsender();
  const healthy = new FakeWalsender();
  const servers: FakeWalsender[] = [parked, healthy];
  const feed = feedOver(() => Promise.resolve(servers.shift() ?? new FakeWalsender()), {
    statusIntervalMs: 1,
  });
  await feed.start({ onChange: () => undefined });
  const chatter = (): void => parked.push(keepalive(0n, 0));
  await waitUntil(() => feed.stats().failure !== null, 'the parked stream to die', chatter);

  await feed.start({ onChange: () => undefined });
  await waitUntil(() => healthy.standby.length >= 3, 'the restarted stream to confirm');
  expect(feed.stats().failure).toBeNull();
  await feed.stop();
});

test('a consumer slow to take a change is not a silent walsender', async () => {
  ensurePostsEntity();
  const server = new SilentWalsender();
  const feed = feedOver(() => Promise.resolve(server), { statusIntervalMs: 1 });
  let release = (): void => undefined;
  const busy = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: ChangeEvent[] = [];
  await feed.start({
    onChange: async (event) => {
      events.push(event);
      await busy;
    },
  });
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
  server.push(xlog(insert(POSTS_OID, ['p1', 't', 'o1', null, null, null])));
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  await waitUntil(() => events.length === 1, 'the change to reach the consumer');

  // Fifty intervals inside `onChange`: the pump is not reading, so no silence is being measured.
  for (let tick = 0; tick < 50; tick += 1) await interval();
  expect(feed.stats().failure).toBeNull();

  release();
  // Back on the socket, and the socket really is silent: now it counts.
  await waitUntil(() => feed.stats().failure !== null, 'the silence after the consumer');
  await feed.stop();
});

/** Silent, and its socket's close never ends the read parked on it — `end()` on a half-open TCP. */
class DeafWalsender extends SilentWalsender {
  override close(): void {
    this.closed = true;
  }
}

test('a stream dropped for silence restarts even when its parked read never returns', async () => {
  ensurePostsEntity();
  const deaf = new DeafWalsender();
  const healthy = new FakeWalsender();
  const servers: FakeWalsender[] = [deaf, healthy];
  const feed = feedOver(() => Promise.resolve(servers.shift() ?? new FakeWalsender()), {
    statusIntervalMs: 1,
  });
  const events: ChangeEvent[] = [];
  await feed.start({ onChange: () => undefined });
  await waitUntil(() => feed.stats().failure !== null, 'the silent stream to die');

  // Settled on microtasks or never: a `start()` waiting on the parked read would still be pending.
  let restarted = false;
  void feed.start({ onChange: (event) => void events.push(event) }).then(() => {
    restarted = true;
  });
  for (let tick = 0; tick < 20 && !restarted; tick += 1) await turns();
  expect(restarted).toBe(true);
  // The old run's read, released late, must not reach the new run's consumer or end it.
  deaf.push(xlog(begin(0x100n, 0n, 7)));
  deaf.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
  deaf.push(xlog(insert(POSTS_OID, ['p1', 't', 'o1', null, null, null])));
  deaf.push(xlog(commit(0x100n, 0x108n, 0n)));
  deaf.push(undefined);
  await turns();
  expect(events).toEqual([]);
  expect(feed.stats().failure).toBeNull();
  await feed.stop();
});
