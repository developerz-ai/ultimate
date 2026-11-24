// The eviction orders: a FIFO across the compaction that keeps its head O(1), and a chain any
// entry leaves in O(1) with its order intact.

import { describe, expect, test } from 'bun:test';
import { Chain, Fifo } from './meter-fifo';

describe('Fifo', () => {
  test('answers in insertion order, through every compaction', () => {
    const queue = new Fifo<number>();
    const out: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      queue.push(i);
      if (i % 3 === 2) out.push(queue.shift() ?? -1, queue.shift() ?? -1);
    }
    expect(queue.size).toBe(1000 - out.length);
    expect(queue.peek()).toBe(out.length);
    while (queue.size > 0) out.push(queue.shift() ?? -1);
    expect(out).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  test('an empty queue answers undefined, and takes pushes again', () => {
    const queue = new Fifo<string>();
    expect(queue.peek()).toBeUndefined();
    expect(queue.shift()).toBeUndefined();
    queue.push('a');
    expect(queue.shift()).toBe('a');
    expect(queue.shift()).toBeUndefined();
    queue.push('b');
    expect([queue.size, queue.peek()]).toEqual([1, 'b']);
  });

  test('a Chain keeps insertion order as entries leave from the head, the middle and the tail', () => {
    const chain = new Chain<string>();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((one) => chain.push(one));
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      expect.unreachable('push answers a link for each entry');
    }
    chain.unlink(b);
    expect([chain.size, chain.first()]).toEqual([3, 'a']);
    chain.unlink(a);
    expect(chain.first()).toBe('c');
    chain.unlink(d);
    chain.unlink(c);
    expect([chain.size, chain.first()]).toEqual([0, undefined]);
    chain.push('e');
    expect([chain.size, chain.first()]).toEqual([1, 'e']);
  });
});
