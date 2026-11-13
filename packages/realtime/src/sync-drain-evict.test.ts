// What the node owes a socket it evicts ITSELF. Bun's `close` callback runs `teardown`; a drain and
// the idle sweep have no callback behind them, so whatever they do instead is the whole release —
// and dropping the socket from the table is three of `teardown`'s five steps, not five.

import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test';
import { clearChannels } from './channel-registry';
import { CLOSE } from './socket';
import { harness, held, NOTHING } from './sync-drain-fixture';
import { turns } from './turns-fixture';

afterAll(() => {
  clearChannels();
});

describe('a socket the node evicts is released the way a closed one is', () => {
  test("Bun's close callback is the reference: it releases all five", async () => {
    const app = harness();
    const ws = await app.seat('s1');
    expect(await held(app, 's1')).toEqual({
      sockets: 1,
      members: ['s1'],
      topicMembers: 1,
      subscription: 'held',
      subscribers: 1,
    });

    app.node.websocket.close(ws);
    await Bun.sleep(0);

    expect(await held(app, 's1')).toEqual(NOTHING);
  });

  test('drain() releases them too — a rolling restart is this path, not the close callback', async () => {
    const app = harness();
    const ws = await app.seat('s1');

    await app.node.drain({ graceMs: 0 });
    await Bun.sleep(0);

    // Presence lives on the SHARED set with a 30s TTL, so a member this node never said goodbye
    // for is rendered by every other node until it expires — while the client is already back on
    // a new node under a new socket id. The live half leaks in-process: `entry.subscribers` never
    // empties, so the matcher, the shared window and the retained ring outlive the process's use
    // for them and `source.forget(qid)` is never called.
    expect(await held(app, 's1')).toEqual(NOTHING);
    expect(ws.closedWith).toBe(CLOSE.goingAway);
  });

  /**
   * The grace is owed to a socket, not to the clock. Measured 2026-09-06 on `x dev`: Ctrl-C took
   * 5.1s with no browser open, and 5.0s of it was this drain sleeping its default grace over a
   * table with nothing in it.
   */
  test('a drain with no sockets waits for nobody', async () => {
    const app = harness();
    const started = performance.now();
    await app.node.drain({ graceMs: 5_000 });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('the grace ends when the last socket leaves, not when the clock says', async () => {
    const app = harness();
    const ws = await app.seat('s1');
    const started = performance.now();
    const draining = app.node.drain({ graceMs: 5_000 });
    // The drain is under way (its grace armed) before the client hangs up.
    await turns(5);
    // Bun's close callback: the client hung up on its own during the grace.
    app.node.websocket.close(ws);
    await draining;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await held(app, 's1')).toEqual(NOTHING);
  });

  /**
   * The `reconnect` frame IS this socket's slot in the spread — there is no cursor behind it and
   * nothing re-sends it — so a client that never received one reconnects on its own backoff, into
   * the herd the spread exists to break. Sent fire-and-forget, a drain that reached half its
   * clients returned a plan claiming it reached all of them.
   */
  test('a reconnect frame the socket refuses is counted, not claimed as delivered', async () => {
    const app = harness();
    const reachable = await app.seat('s1');
    const drowning = await app.seat('s2');
    drowning.buffered = 4 * 1024 * 1024;

    const plan = await app.node.drain({ graceMs: 0 });

    expect(
      // Sorted by the NAMED field before mapping: `[socketId, notified]` is a `(string | boolean)[]`
      // to TypeScript, so `a[0]` was `string | boolean | undefined` and the comparison read an
      // index nothing guaranteed was there.
      [...plan]
        .sort((a, b) => a.socketId.localeCompare(b.socketId))
        .map((entry) => [entry.socketId, entry.notified]),
    ).toEqual([
      ['s1', true],
      ['s2', false],
    ]);
    expect(reachable.sent.some((frame) => frame.type === 'reconnect')).toBe(true);
    expect(drowning.sent.some((frame) => frame.type === 'reconnect')).toBe(false);
  });

  /** `ms` of Bun's fake time, then event-loop turns (`setImmediate` is left real). */
  const elapse = async (ms: number): Promise<void> => {
    jest.advanceTimersByTime(ms);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  afterEach(() => {
    jest.useRealTimers();
  });

  test('the idle sweep releases them too, and it has a caller at all', async () => {
    // Short enough that `start()` arms a sub-second pass; the clock the budget is measured on is
    // frozen and driven by the test, and the interval is a real one on Bun's fake timers — it
    // fires because the test moves them (`elapse`), never because 1.4 s went by.
    const app = harness({ idleTimeoutMs: 4_000 });
    const ws = await app.seat('s1');
    jest.useFakeTimers();
    await app.node.start();

    app.tick(10_000);
    await elapse(1_400);

    expect(await held(app, 's1')).toEqual(NOTHING);
    expect(ws.closedWith).toBe(CLOSE.idle);
    await app.node.stop();
  });

  test('a socket inside its idle budget is left alone', async () => {
    const app = harness({ idleTimeoutMs: 4_000 });
    await app.seat('s1');
    jest.useFakeTimers();
    await app.node.start();

    app.tick(1_000);
    await elapse(1_400);

    expect(app.sockets.count).toBe(1);
    await app.node.stop();
  });
});
