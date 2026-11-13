import { describe, expect, test } from 'bun:test';
import { createTurnQueue } from './pglite-turns';

/**
 * One macrotask: every promise the queue chains has settled by then. The queue is pure promises,
 * so after a turn a caller that could have run, has — a negative read here is a fact, not a race.
 */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('createTurnQueue', () => {
  test('runs work in the order it arrived, never overlapping', async () => {
    const queue = createTurnQueue();
    const order: string[] = [];
    let releaseA = (): void => undefined;
    const aHeld = new Promise<void>((done) => (releaseA = done));
    const work = (name: string, gate: Promise<void>) =>
      queue.run(async () => {
        order.push(`${name}:start`);
        await gate;
        order.push(`${name}:end`);
      });

    // `a` holds until released: without the queue `b` and `c` would start beside it.
    const all = Promise.all([work('a', aHeld), work('b', settle()), work('c', settle())]);
    await settle();
    expect(order).toEqual(['a:start']);
    releaseA();
    await all;
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  test('a taken turn is held until it is released, and the next caller waits', async () => {
    const queue = createTurnQueue();
    const turn = await queue.take();
    let ran = false;
    const next = queue.run(async () => {
      ran = true;
    });

    await settle();
    expect(ran).toBe(false);
    turn.release();
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
    await settle();
    expect(secondTaken).toBe(false);
    release.release();
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

  test('`using` gives the turn back on the way out of the block', async () => {
    const queue = createTurnQueue();
    let ran = false;
    let next: Promise<void> | undefined;

    {
      using turn = await queue.take();
      next = queue.run(async () => {
        ran = true;
      });
      await settle();
      expect(ran).toBe(false);
      expect(turn.release).toBeInstanceOf(Function);
    }

    await next;
    expect(ran).toBe(true);
  });

  test('`using` gives the turn back even when the block throws', async () => {
    const queue = createTurnQueue();

    await expect(
      (async () => {
        using turn = await queue.take();
        void turn;
        throw new Error('block failed');
      })(),
    ).rejects.toThrow('block failed');

    expect(await queue.run(async () => 'next')).toBe('next');
  });
});
