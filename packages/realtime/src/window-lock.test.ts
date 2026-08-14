// The lane's two promises: order and isolation. A queued task starts only after the one before it
// settles, and a task that rejected takes its rejection to its own caller and nowhere else.

import { describe, expect, test } from 'bun:test';
import { WindowLock } from './window-lock';

/** A promise the test resolves by hand — the only way to hold a lane open across a tick. */
function held(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { promise, release };
}

describe('WindowLock', () => {
  test('a task queued behind another does not start until the first one settles', async () => {
    const lock = new WindowLock();
    const first = held();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push('a:in');
      await first.promise;
      order.push('a:out');
    });
    const b = lock.run(async () => {
      order.push('b:in');
    });

    // The whole point: `b` is a task with nothing to await, and it still has not run.
    await Promise.resolve();
    expect(order).toEqual(['a:in']);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:in', 'a:out', 'b:in']);
  });

  test('tasks run in call order however long each one takes', async () => {
    const lock = new WindowLock();
    const order: number[] = [];
    // Descending waits: whichever finishes first, the lane decides who *starts* first.
    const runs = [3, 2, 1, 0].map((ticks, index) =>
      lock.run(async () => {
        for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
        order.push(index);
      }),
    );

    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test('the caller gets its own task’s value', async () => {
    const lock = new WindowLock();
    await expect(lock.run(async () => 41 + 1)).resolves.toBe(42);
  });

  test('a rejected task rejects its caller and does not wedge the lane', async () => {
    const lock = new WindowLock();
    const ran: string[] = [];

    const failed = lock.run(async () => {
      ran.push('failed');
      // Deliberately not an `UltimateError`: the lane must isolate whatever a task throws, and a
      // framework error here would let the isolation be mistaken for code-aware handling.
      throw new TypeError('fanout blew up');
    });
    const after = lock.run(async () => {
      ran.push('after');
      return 'delivered';
    });

    await expect(failed).rejects.toThrow('fanout blew up');
    // One delivery that threw must not be every later delivery for this query id failing with it.
    await expect(after).resolves.toBe('delivered');
    expect(ran).toEqual(['failed', 'after']);
  });

  test('a task that throws before its first await rejects rather than escaping the lane', async () => {
    const lock = new WindowLock();
    const thrown = lock.run(() => {
      // A non-framework class again, for the same reason, and it keeps this file free of bare
      // `Error` — the rule the framework itself is held to.
      throw new TypeError('synchronous');
    });

    await expect(thrown).rejects.toThrow('synchronous');
    await expect(lock.run(async () => 'still here')).resolves.toBe('still here');
  });
});
