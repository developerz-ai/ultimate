// Bounded console and network history. BOUNDED is the whole point: a scrape of ten thousand
// pages that kept every console line and every request holds the run's entire browsing history in
// the worker's heap, and the incident is an OOM two hours in rather than a scraper bug.

export interface ConsoleLine {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly text: string;
  readonly at: number;
}

export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  /** Absent while the request is still in flight or was aborted by interception. */
  readonly status?: number | undefined;
  readonly resourceType: ResourceType;
  readonly at: number;
  /** Set when interception refused it — `blocked` for `block:`, `host` for `allowHosts`. */
  readonly refused?: 'blocked' | 'host' | 'robots' | undefined;
}

export const RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'websocket',
  'other',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const DEFAULT_RING_CAPACITY = 200;

export interface Ring<T> {
  readonly capacity: number;
  push(entry: T): void;
  /** Oldest first. A copy — a caller holding the ring's own array would see it mutate. */
  entries(): readonly T[];
  /** How many were dropped to keep the bound. Non-zero is the honest "you are not seeing it all". */
  readonly dropped: number;
  clear(): void;
}

export type ConsoleRing = Ring<ConsoleLine>;
export type NetworkRing = Ring<NetworkEntry>;

export function createRing<T>(capacity: number = DEFAULT_RING_CAPACITY): Ring<T> {
  const items: T[] = [];
  let dropped = 0;
  return {
    capacity,
    push(entry: T): void {
      items.push(entry);
      while (items.length > capacity) {
        items.shift();
        dropped += 1;
      }
    },
    entries: () => [...items],
    get dropped(): number {
      return dropped;
    },
    clear(): void {
      items.length = 0;
      dropped = 0;
    },
  };
}
