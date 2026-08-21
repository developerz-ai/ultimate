// Bounded console, page-error and network history. BOUNDED is the whole point: a scrape of ten
// thousand pages that kept every console line and every request holds the run's entire browsing
// history in the worker's heap, and the incident is an OOM two hours in rather than a scraper bug.

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

/**
 * An uncaught exception the PAGE threw — the half a picture cannot carry.
 *
 * Its own entry type, and not a `ConsoleLine` with `level: 'error'`, because it is a different
 * event: a page that threw called no console method, so folding one into the console stream
 * reports a `console.error` that never happened — and `ConsoleLine` has nowhere to keep the stack,
 * which is the field that says WHICH island threw.
 */
export interface PageError {
  /** The exception's message. `''` when the payload carried none — never a fabricated one. */
  readonly message: string;
  /**
   * The JS stack, when the exception carried one. Absent means the payload had none, never that
   * the throw had no origin: a `throw 'a string'` in the page reaches here with a message alone.
   */
  readonly stack?: string | undefined;
  readonly at: number;
}

/**
 * The per-entry cap, which the ring itself cannot give: a ring bounds the COUNT, and one
 * `RangeError: Maximum call stack size exceeded` carries thousands of frames — 200 of those is
 * megabytes held per page, which is the same OOM this file exists to prevent, one level down.
 */
export const MAX_PAGE_ERROR_CHARS = 4_000;

const clamped = (text: string): string =>
  text.length <= MAX_PAGE_ERROR_CHARS ? text : `${text.slice(0, MAX_PAGE_ERROR_CHARS - 1)}…`;

/**
 * The ONE way a `PageError` is built. A driver that assembled the object literal itself would be
 * a driver whose stacks are unbounded, and the truncation would then be a rule per driver rather
 * than a property of the type.
 */
export function pageErrorEntry(input: {
  readonly message: string;
  readonly stack?: string | undefined;
  readonly at: number;
}): PageError {
  // An empty stack is ABSENT, not empty: `stack: ''` prints as a blank stack, which reads as
  // "the exception had no origin" rather than "the payload did not carry one".
  const stack = input.stack === undefined || input.stack === '' ? undefined : clamped(input.stack);
  return {
    message: clamped(input.message),
    ...(stack === undefined ? {} : { stack }),
    at: input.at,
  };
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
export type PageErrorRing = Ring<PageError>;

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
