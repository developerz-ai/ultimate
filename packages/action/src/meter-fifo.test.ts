// The eviction queue: first in, first out, across the compaction that keeps its head O(1).

import { describe, expect, test } from 'bun:test';
import { Fifo } from './meter-fifo';

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
});
