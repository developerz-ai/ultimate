import { describe, expect, test } from 'bun:test';
import { createTurnQueue } from './pglite-turns';

describe('createTurnQueue', () => {
  test('runs work in the order it arrived, never overlapping', async () => {
    const queue = createTurnQueue();
    const order: string[] = [];
    const work = (name: string, ms: number) =>
      queue.run(async () => {
        order.push(`${name}:start`);
        await Bun.sleep(ms);
        order.push(`${name}:end`);
      });

    // The slow one first: without the queue it would still be running when `b` started.
    await Promise.all([work('a', 20), work('b', 1), work('c', 1)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  test('a taken turn is held until it is released, and the next caller waits', async () => {
    const queue = createTurnQueue();
    const turn = await queue.take();
    let ran = false;
    const next = queue.run(async () => {
      ran = true;
    });

    await Bun.sleep(5);
    expect(ran).toBe(false);
    turn();
    await next;
    expect(ran).toBe(true);
  });

  test('two synchronous takes queue behind each other rather than sharing the connection', async () => {
    const queue = createTurnQueue();
    const [first, second] = [queue.take(), queue.take()];
    let secondTaken = false;
    void second.then(() => {
      secondTaken = true;
    });

    const release = await first;
    await Bun.sleep(5);
    expect(secondTaken).toBe(false);
    release();
    await second;
    expect(secondTaken).toBe(true);
  });

  test('work that throws still gives the turn back — one bad statement is not a stalled process', async () => {
    const queue = createTurnQueue();
    await expect(
      queue.run(async () => {
        throw new Error('statement failed');
      }),
    ).rejects.toThrow('statement failed');

    expect(await queue.run(async () => 'next')).toBe('next');
  });
});
