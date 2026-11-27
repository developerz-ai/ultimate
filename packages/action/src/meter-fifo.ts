/**
 * The memory meter store's eviction order, two shapes: `Fifo`, a key order taken from the head only
 * (O(1) push, amortized O(1) shift), and `Chain`, a counter order any entry leaves in O(1). Not a
 * `Set`: its iterator restarts at the table's first slot and walks every deleted one until the
 * table rehashes, so taking the head after each delete grew per draw.
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

/** One entry of a `Chain`, held by its owner so it can leave in O(1). */
export interface ChainLink<T> {
  readonly value: T;
  prev: ChainLink<T> | undefined;
  next: ChainLink<T> | undefined;
}

/**
 * An insertion-ordered list whose entries leave from anywhere in O(1): the owner keeps the link
 * `push` answers and hands it to `unlink`. Nothing retired waits in it for the head to reach it.
 */
export class Chain<T> {
  private head: ChainLink<T> | undefined;
  private tail: ChainLink<T> | undefined;
  private count = 0;

  get size(): number {
    return this.count;
  }

  first(): T | undefined {
    return this.head?.value;
  }

  push(value: T): ChainLink<T> {
    const link: ChainLink<T> = { value, prev: this.tail, next: undefined };
    if (this.tail === undefined) this.head = link;
    else this.tail.next = link;
    this.tail = link;
    this.count += 1;
    return link;
  }

  unlink(link: ChainLink<T>): void {
    if (link.prev === undefined) this.head = link.next;
    else link.prev.next = link.next;
    if (link.next === undefined) this.tail = link.prev;
    else link.next.prev = link.prev;
    link.prev = undefined;
    link.next = undefined;
    this.count -= 1;
  }
}
