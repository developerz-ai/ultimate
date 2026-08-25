// Bounded console, page-error and network history. BOUNDED is the whole point: a scrape of ten
// thousand pages that kept every console line and every request holds the run's entire browsing
// history in the worker's heap, and the incident is an OOM two hours in rather than a scraper bug.

import { assert } from '@ultimat3/core';

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

/**
 * REFUSED rather than clamped, the shape `@ultimat3/storage`'s `resolveListLimit` uses — a bound
 * with no code of its own is still a coded refusal, never a bare `Error`.
 *
 * Both wrong values fail in opposite directions and neither is survivable. A NEGATIVE capacity
 * makes `while (items.length > capacity) items.shift()` spin forever on an already-empty array
 * (`0 > -1`): `createRing(-1).push(1)` never returns, and it is a synchronous loop on the worker's
 * only thread, inside a `page.on('request')` handler — past `ctx.signal`, past the wedge watchdog
 * and past the job timeout, which is incident #1 in this file's header. `NaN` fails the other way:
 * the comparison is false forever, the ring is UNBOUNDED, and the OOM the bound exists to prevent
 * arrives two hours in. Zero is a ring that discards everything silently, and a fraction is a
 * bound that is not the number anybody asked for.
 */
export function createRing<T>(capacity: number = DEFAULT_RING_CAPACITY): Ring<T> {
  assert(
    Number.isSafeInteger(capacity) && capacity > 0,
    `a ring capacity must be a positive integer, got ${String(capacity)}: a negative one spins forever on push() and NaN makes the ring unbounded`,
    `pass a positive capacity — createRing(${String(DEFAULT_RING_CAPACITY)}) — or omit it and take DEFAULT_RING_CAPACITY`,
  );
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
