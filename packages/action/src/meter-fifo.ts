/**
 * A first-in-first-out queue with O(1) push and amortized O(1) peek and shift, for the memory meter
 * store's eviction order. Not a `Set`: its iterator restarts at the table's first slot and walks
 * every deleted one until the table rehashes, so taking the head after each delete grew per draw.
 */

export class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  peek(): T | undefined {
    return this.head < this.items.length ? this.items[this.head] : undefined;
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.head += 1;
    // Compacted once the consumed half outweighs the rest: each item is copied O(1) times.
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}
