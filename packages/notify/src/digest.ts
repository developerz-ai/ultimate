// The digest window: N events for one recipient over one channel, coalesced into one delivery.
//
// A ROLLING window measured in milliseconds from the first event, and deliberately not a calendar
// one. "Every day at 09:00" needs an IANA zone per recipient and a cron, which is `task()` plus the
// app's own schedule — and this repo's rule is that no date is computed without an explicit zone,
// so a window this package could get wrong is a window it does not offer. `windowMs` needs no zone
// because it does no calendar arithmetic at all.

import type { NotifyEvent } from './notification';

/** One coalescing bucket's identity. */
export interface DigestSlot {
  readonly recipient: string;
  readonly notifier: string;
  readonly channel: string;
  /**
   * What the window groups BY, within the slot. Defaults to the notifier's name, so every
   * `post.commented` for one person coalesces; an app that wants one digest per thread returns
   * the thread id. The taxonomy that names those groups is the app's, exactly as with preferences.
   */
  readonly group: string;
}

export interface DigestAppend {
  readonly slot: DigestSlot;
  readonly event: NotifyEvent<unknown>;
  readonly windowMs: number;
  readonly now: Date;
}

export interface DigestBucket {
  /**
   * True when THIS append opened the window. Exactly one caller gets it per window, and that
   * caller owns the flush — which is what stops N concurrent runs each scheduling their own.
   */
  readonly opened: boolean;
  /** Epoch ms the window closes at. */
  readonly endsAt: number;
}

export interface DigestStore {
  append(input: DigestAppend): Promise<DigestBucket>;
  /**
   * Everything the window collected, oldest first, and the bucket is closed.
   *
   * THE ONE AT-MOST-ONCE SEAM IN THIS PACKAGE, stated rather than hidden: a process killed between
   * this call and the send loses that batch, because the events are no longer anywhere to replay
   * from. The fan-out narrows it by checkpointing the drained batch in its own `step.run` before
   * the send — an ordinary retry replays from that checkpoint — and a durable implementation can
   * close it entirely by flipping a row's status here and deleting on `settle`. The memory store
   * below cannot.
   */
  /**
   * `endsAt` names the window this flush owns (what `append` answered it). Every window of the
   * slot closing at or before it is taken — its own, and an OLDER one a crashed flush left behind
   * — while a newer window, opened after this one closed, stays for its own flush. Omitted, only
   * the oldest window is taken.
   */
  drain(slot: DigestSlot, endsAt?: number): Promise<readonly NotifyEvent<unknown>[]>;
}

const slotKey = (slot: DigestSlot): string =>
  JSON.stringify([slot.recipient, slot.notifier, slot.channel, slot.group]);

interface OpenBucket {
  endsAt: number;
  readonly events: NotifyEvent<unknown>[];
}

export interface MemoryDigestStore extends DigestStore {
  readonly open: number;
  clear(): void;
}

/**
 * A QUEUE of windows per slot, oldest first. One bucket per slot replaced a closed window that its
 * flush had not drained yet, so an append arriving between a window's end and its drain lost every
 * event the earlier window held. A closed window is now sealed under its `endsAt`, and a later
 * append opens the next one beside it.
 */
export function createMemoryDigestStore(): MemoryDigestStore {
  const slots = new Map<string, OpenBucket[]>();
  return {
    get open(): number {
      let count = 0;
      for (const windows of slots.values()) count += windows.length;
      return count;
    },
    append(input) {
      const id = slotKey(input.slot);
      const at = input.now.getTime();
      const windows = slots.get(id) ?? [];
      const newest = windows.at(-1);
      // An elapsed window is SEALED — its flush drains it — and never appended to: the event
      // opens the next window, which is one extra delivery rather than a lost one.
      if (newest !== undefined && newest.endsAt > at) {
        newest.events.push(input.event);
        return Promise.resolve({ opened: false, endsAt: newest.endsAt });
      }
      const endsAt = at + input.windowMs;
      windows.push({ endsAt, events: [input.event] });
      slots.set(id, windows);
      return Promise.resolve({ opened: true, endsAt });
    },
    drain(slot, endsAt) {
      const id = slotKey(slot);
      const windows = slots.get(id) ?? [];
      const cut = endsAt === undefined ? 1 : windows.filter((w) => w.endsAt <= endsAt).length;
      const taken = windows.splice(0, Math.max(cut, 0));
      if (windows.length === 0) slots.delete(id);
      return Promise.resolve(taken.flatMap((window) => window.events));
    },
    clear() {
      slots.clear();
    },
  };
}
