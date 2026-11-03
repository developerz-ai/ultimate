// What the node owes a socket it evicts ITSELF. Bun's `close` callback runs `teardown`; a drain and
// the idle sweep have no callback behind them, so whatever they do instead is the whole release —
// and dropping the socket from the table is three of `teardown`'s five steps, not five.

import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test';
import { type ChangeEvent, formatLsn } from './changefeed';
import { clearChannels } from './channel-registry';
import {
  type Harness,
  harness,
  POLICY_STORE_DOWN,
  type RecordingWs,
  ROWS,
} from './sync-drain-fixture';
import type { Frame } from './sync-protocol';

afterAll(() => {
  clearChannels();
});

describe("Bun's drain repairs a subscriber backpressure left behind", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const SID = 'q-s1';
  const change = (position: number): ChangeEvent => ({
    table: 'posts',
    op: 'update',
    before: null,
    after: { id: 'p1', orgId: 'o1', title: `v${String(position)}` },
    lsn: formatLsn(position),
    txid: String(position),
    orgId: 'o1',
    at: 1_000,
    write: null,
  });

  /** A socket whose patch was refused: marked, and the buffer has since emptied. */
  const dropped = async (app: Harness): Promise<RecordingWs> => {
    const ws = await app.seat('s1');
    ws.buffered = 4 * 1024 * 1024;
    await app.registry.deliver(change(2));
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);
    ws.buffered = 0;
    ws.sent.length = 0;
    return ws;
  };

  const snapshots = (ws: RecordingWs): readonly Frame[] =>
    ws.sent.filter((frame) => frame.type === 'snapshot');

  const drain = async (app: Harness, ws: RecordingWs): Promise<void> => {
    app.node.websocket.drain(ws);
    await Bun.sleep(0);
  };

  test('with no later change it delivers one snapshot and clears the mark', async () => {
    const app = harness();
    const ws = await dropped(app);

    await drain(app, ws);

    const frames = snapshots(ws);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame?.type !== 'snapshot') expect.unreachable('the repair is a snapshot');
    // The window the refused patch was folded into, so the repair holds what the patch carried.
    expect(frame.rows[0]?.['title']).toBe('v2');
    expect(frame.sid).toBe(SID);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
    expect(app.registry.subscription('s1', SID)?.cursor.lsn).toBe(formatLsn(2));
  });

  test('a second drain sends nothing', async () => {
    const app = harness();
    const ws = await dropped(app);
    await drain(app, ws);
    ws.sent.length = 0;

    await drain(app, ws);

    expect(ws.sent).toEqual([]);
  });

  test('two drains landing together send one snapshot', async () => {
    const app = harness();
    const ws = await dropped(app);

    app.node.websocket.drain(ws);
    await drain(app, ws);

    expect(snapshots(ws)).toHaveLength(1);
  });

  test('a healthy socket is sent nothing', async () => {
    const app = harness();
    const ws = await app.seat('s1');
    ws.sent.length = 0;

    await drain(app, ws);

    expect(ws.sent).toEqual([]);
  });

  test('a gate that cannot decide keeps the mark, and a later drain still repairs', async () => {
    let broken = false;
    const app = harness({
      visible: () => {
        if (broken) throw POLICY_STORE_DOWN;
        return true;
      },
    });
    const ws = await dropped(app);

    broken = true;
    await drain(app, ws);
    expect(snapshots(ws)).toEqual([]);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);

    broken = false;
    await drain(app, ws);
    expect(snapshots(ws)).toHaveLength(1);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
  });

  test('a repair the socket refuses again keeps the mark', async () => {
    const app = harness();
    const ws = await dropped(app);
    ws.buffered = 4 * 1024 * 1024;

    await drain(app, ws);

    expect(ws.sent).toEqual([]);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);
  });

  test('a window nothing trusts stays marked: the next change re-reads it first', async () => {
    const app = harness();
    const ws = await app.seat('s1');
    app.registry.invalidate();
    ws.sent.length = 0;

    await drain(app, ws);

    expect(ws.sent).toEqual([]);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);
  });

  test('a re-read in flight is not trusted either: `stale` is already cleared under it', async () => {
    let held: Promise<void> | null = null;
    const app = harness({
      snapshot: async () => {
        await held;
        return { rows: ROWS, lsn: '' };
      },
    });
    const ws = await dropped(app);
    app.registry.invalidate();
    let release = (): void => undefined;
    held = new Promise((resolve) => {
      release = resolve;
    });
    // A cold subscriber forces the read, and the rows under it are the ones it was forced to replace.
    await app.seat('s2');

    await drain(app, ws);
    expect(snapshots(ws)).toEqual([]);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);

    release();
    await Bun.sleep(0);
    await drain(app, ws);
    expect(snapshots(ws)).toHaveLength(1);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
  });

  test('a mark refused during a read is repaired when the read lands, with no second drain', async () => {
    let held: Promise<void> | null = null;
    const app = harness({
      snapshot: async () => {
        await held;
        return { rows: ROWS, lsn: '' };
      },
    });
    const ws = await dropped(app);
    app.registry.invalidate();
    let release = (): void => undefined;
    held = new Promise((resolve) => {
      release = resolve;
    });
    await app.seat('s2');
    await drain(app, ws);
    expect(snapshots(ws)).toEqual([]);

    release();
    await Bun.sleep(0);

    expect(snapshots(ws)).toHaveLength(1);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
  });

  /** The node's sweep, on Bun's fake timers: `start()` arms it at a quarter of the idle budget. */
  const sweep = async (): Promise<void> => {
    jest.advanceTimersByTime(1_000);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  test('a window nothing trusts is re-read by the sweep, and its marks answered', async () => {
    let reads = 0;
    const app = harness({
      idleTimeoutMs: 60_000,
      snapshot: async () => {
        reads += 1;
        return { rows: ROWS, lsn: '' };
      },
    });
    const ws = await app.seat('s1');
    app.registry.invalidate();
    ws.sent.length = 0;
    const before = reads;
    jest.useFakeTimers();
    await app.node.start();

    jest.advanceTimersByTime(15_000);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(reads).toBe(before + 1);
    expect(snapshots(ws)).toHaveLength(1);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);

    // Nothing left marked: the next pass reads nothing and sends nothing.
    jest.advanceTimersByTime(15_000);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(reads).toBe(before + 1);
    expect(snapshots(ws)).toHaveLength(1);
    await app.node.stop();
  });

  test('a gate that cannot decide is retried by the sweep, with no drain and no change', async () => {
    let broken = false;
    const app = harness({
      idleTimeoutMs: 4_000,
      visible: () => {
        if (broken) throw POLICY_STORE_DOWN;
        return true;
      },
    });
    const ws = await dropped(app);
    broken = true;
    await drain(app, ws);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);
    broken = false;
    jest.useFakeTimers();
    await app.node.start();
    app.sockets.get('s1')?.touch();

    await sweep();

    expect(snapshots(ws)).toHaveLength(1);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
    await app.node.stop();
  });

  test('a drain during a read waits it out and repairs, with nothing else to re-run it', async () => {
    let held: Promise<void> | null = null;
    const app = harness({
      snapshot: async () => {
        await held;
        return { rows: ROWS, lsn: '' };
      },
    });
    const ws = await dropped(app);
    let release = (): void => undefined;
    held = new Promise((resolve) => {
      release = resolve;
    });
    // A read no landing repair follows: discarded, because a change passes it while it is out.
    await app.seat('s2');
    await app.registry.deliver(change(3));
    ws.buffered = 4 * 1024 * 1024;
    await app.registry.deliver(change(4));
    ws.buffered = 0;
    ws.sent.length = 0;

    await drain(app, ws);
    expect(snapshots(ws)).toEqual([]);
    release();
    await Bun.sleep(0);

    expect(snapshots(ws)).toHaveLength(1);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
  });

  test('a read whose answer the window moved past leaves its marks repairable', async () => {
    let held: Promise<void> | null = null;
    const app = harness({
      snapshot: async () => {
        await held;
        return { rows: ROWS, lsn: '' };
      },
    });
    const ws = await dropped(app);
    let release = (): void => undefined;
    held = new Promise((resolve) => {
      release = resolve;
    });
    await app.seat('s2');
    // Folded while the read is out, so what it answers is behind the window and is discarded.
    await app.registry.deliver(change(3));
    ws.buffered = 4 * 1024 * 1024;
    await app.registry.deliver(change(4));
    ws.buffered = 0;
    ws.sent.length = 0;
    release();
    await Bun.sleep(0);
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(true);

    await drain(app, ws);

    const frame = snapshots(ws)[0];
    if (frame?.type !== 'snapshot') expect.unreachable('the repair is a snapshot');
    expect(frame.rows[0]?.['title']).toBe('v4');
    expect(app.sockets.get('s1')?.desynced.has(SID)).toBe(false);
  });

  test('a subscription dropped meanwhile is not repaired', async () => {
    const app = harness();
    const ws = await dropped(app);
    app.registry.unsubscribe('s1', SID);

    await drain(app, ws);

    expect(snapshots(ws)).toEqual([]);
  });
});
