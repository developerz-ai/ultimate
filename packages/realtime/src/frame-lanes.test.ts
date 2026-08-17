// The lane table itself: FIFO per key, concurrent across keys, and empty again when the work is
// done — the key is a client-chosen sid, so a lane that outlived its frame would be a map one
// socket can grow without limit.

import { describe, expect, test } from 'bun:test';
import { FrameLanes, laneKeyOf } from './frame-lanes';
import { PROTOCOL_VERSION } from './sync-protocol';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('FrameLanes', () => {
  test('runs one key in call order, whatever order the work settles in', async () => {
    const lanes = new FrameLanes();
    const first = deferred();
    const order: string[] = [];

    const a = lanes.run('k', async () => {
      await first.promise;
      order.push('a');
    });
    const b = lanes.run('k', async () => {
      order.push('b');
    });
    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(['a', 'b']);
  });

  test('different keys do not wait on each other', async () => {
    const lanes = new FrameLanes();
    const blocked = deferred();
    const order: string[] = [];

    const held = lanes.run('slow', async () => {
      await blocked.promise;
      order.push('slow');
    });
    await lanes.run('other', async () => {
      order.push('other');
    });

    expect(order).toEqual(['other']);
    blocked.resolve();
    await held;
    expect(order).toEqual(['other', 'slow']);
  });

  test('a lane that throws does not reject the frame queued behind it', async () => {
    const lanes = new FrameLanes();
    const ran: string[] = [];

    const failing = lanes.run('k', async () => {
      throw new TypeError('handler blew up');
    });
    const next = lanes.run('k', async () => {
      ran.push('next');
    });

    await expect(failing).rejects.toThrow(TypeError);
    await expect(next).resolves.toBeUndefined();
    expect(ran).toEqual(['next']);
  });

  test('a frame arriving while the lane still has work joins it rather than overtaking it', async () => {
    const lanes = new FrameLanes();
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const a = lanes.run('k', async () => {
      await first.promise;
      order.push('a');
    });
    const b = lanes.run('k', async () => {
      await second.promise;
      order.push('b');
    });
    first.resolve();
    // `a` has settled and `b` is running: the moment the lane would be dropped if it were dropped
    // per task rather than when it is actually idle. A `c` given a fresh lane here runs at once.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const c = lanes.run('k', async () => {
      order.push('c');
    });
    second.resolve();
    await Promise.all([a, b, c]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('the table is empty once the work is done', async () => {
    const lanes = new FrameLanes();
    const held = deferred();

    const running = lanes.run('k', async () => {
      await held.promise;
    });
    const queued = lanes.run('k', async () => undefined);
    expect(lanes.size).toBe(1);
    held.resolve();
    await Promise.all([running, queued]);

    expect(lanes.size).toBe(0);
  });
});

describe('laneKeyOf', () => {
  test('every mutation on one socket shares one lane', () => {
    expect(
      laneKeyOf({
        type: 'mutate',
        v: PROTOCOL_VERSION,
        key: 'm1',
        seq: 1,
        name: 'likePost',
        input: null,
      }),
    ).toBe('mutate');
  });

  test('a subscription is its own lane, keyed by the identity a drop names', () => {
    expect(
      laneKeyOf({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: 'S',
        target: { kind: 'query', qid: 'liveFeed', input: null, cursor: null },
      }),
    ).toBe('sub:S');
    expect(
      laneKeyOf({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'drop',
        sid: 'other',
        target: { kind: 'topic', topic: 'org.o1.cursors' },
      }),
    ).toBe('topic:org.o1.cursors');
  });

  test('a frame that orders nothing takes no lane', () => {
    expect(
      laneKeyOf({
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: 'b',
        sessionId: null,
        actorId: null,
      }),
    ).toBeNull();
  });
});
