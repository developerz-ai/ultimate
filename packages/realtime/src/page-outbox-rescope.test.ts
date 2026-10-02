// The outbox across a principal change, at every await it owns: a write parked in the flush, a
// queue still opening, the single-flight slot, and a disk that refuses the wipe or the open. No
// clock, no sleep — every interleaving is gated by hand over `MemoryLocalStore`.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { type LocalStore, MemoryLocalStore } from './local-store-idb';
import type { OutboxEntry } from './page-outbox';
import { createOutbox } from './page-outbox';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox-locks'));
});

const entry = (key: string): OutboxEntry => ({ key, name: 'likePost', input: { key } });

/** A step the test releases by hand; `entered` settles when the code under test reaches it. */
function gate(): {
  readonly entered: Promise<void>;
  open(): void;
  fail(error: unknown): void;
  wait(): Promise<void>;
} {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  let refuse: (error: unknown) => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  return {
    entered,
    open: () => release(),
    fail: (error) => refuse(error),
    wait: () => {
      enter();
      return released;
    },
  };
}

const keysOf = async (local: LocalStore, scope: string): Promise<string[]> =>
  ((await local.queue(scope))?.mutations ?? []).map((mutation) => mutation.key);

const turns = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

describe('a write issued under one principal', () => {
  test('parked in the flush while the principal changes is REFUSED — never queued as the next', async () => {
    const local = new MemoryLocalStore();
    rescope('u1');
    const flush = gate();
    const sent: string[] = [];
    const outbox = createOutbox({
      local,
      overlays: () => undefined,
      beforeEnqueue: () => flush.wait(),
      send: async (queued) => {
        sent.push(queued.key);
        return {};
      },
    });
    await outbox.ready;

    const queued = outbox.enqueue(entry('u1-like')).then(
      () => 'queued',
      (error: unknown) => error,
    );
    await flush.entered;
    rescope('u2');
    await outbox.ready;
    flush.open();

    expect(await queued).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
    expect(await keysOf(local, 'p:u1')).toEqual([]);
    expect(await keysOf(local, 'p:u2')).toEqual([]);
    await outbox.replay();
    expect(sent).toEqual([]);
  });

  test('made while the NEXT queue is still opening, and overtaken by a third principal, is refused too', async () => {
    const inner = new MemoryLocalStore();
    const opening = gate();
    let hold = false;
    const local: LocalStore = {
      kind: inner.kind,
      rows: (scope) => inner.rows(scope),
      write: (scope, puts, deletes) => inner.write(scope, puts, deletes),
      queue: async (scope) => {
        if (hold && scope === 'p:u2') await opening.wait();
        return await inner.queue(scope);
      },
      writeQueue: (scope, change) => inner.writeQueue(scope, change),
      wipe: (scope) => inner.wipe(scope),
      wipeOthers: (keep) => inner.wipeOthers(keep),
    };
    rescope('u1');
    const outbox = createOutbox({ local, overlays: () => undefined, send: async () => ({}) });
    await outbox.ready;
    hold = true;
    rescope('u2');
    // u2's write, while u2's queue is still being read off the disk.
    const queued = outbox.enqueue(entry('u2-like')).then(
      () => 'queued',
      (error: unknown) => error,
    );
    await opening.entered;
    hold = false;
    rescope('u3');
    opening.open();
    await outbox.ready;

    expect(await queued).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
    expect(await keysOf(inner, 'p:u3')).toEqual([]);
    // And the queue that finished opening for u2 after u2 left was never the page's.
    expect(outbox.size).toBe(0);
    await outbox.enqueue(entry('u3-like'));
    expect(await keysOf(inner, 'p:u3')).toEqual(['u3-like']);
  });
});

describe('the single-flight slot across a principal change', () => {
  test("the next principal's trigger gets a pass of its OWN: its queue drains, its report names its keys", async () => {
    const local = new MemoryLocalStore();
    // u2 already has a write on disk from an earlier session in this browser.
    await local.writeQueue('p:u2', {
      puts: [
        {
          key: 'u2-old',
          seq: 1,
          name: 'likePost',
          input: {},
          enqueuedAt: 0,
          attempts: 0,
          status: 'pending',
          error: null,
        },
      ],
      deletes: [],
      nextSeq: 2,
    });
    rescope('u1');
    const parked = gate();
    const sent: string[] = [];
    const outbox = createOutbox({
      local,
      overlays: () => undefined,
      send: async (queued) => {
        sent.push(queued.key);
        if (queued.key === 'u1-a') await parked.wait();
        return {};
      },
    });
    await outbox.enqueue(entry('u1-a'));
    const first = outbox.replay().catch((error: unknown) => error);
    await parked.entered;

    rescope('u2');
    const second = await outbox.replay();

    expect(second).toEqual({ sent: 1, collapsed: 0, remaining: 0, stoppedAt: null });
    expect(sent).toEqual(['u1-a', 'u2-old']);
    expect(outbox.size).toBe(0);
    expect(await keysOf(local, 'p:u2')).toEqual([]);

    // u1's send finally fails: nothing of it reaches u2's outbox, and no follow-up pass is owed.
    parked.fail(new TypeError('network down'));
    await first;
    await turns();
    expect(sent).toEqual(['u1-a', 'u2-old']);
  });
});

describe('a disk that refuses', () => {
  test('a wipe that fails does not poison the tab: the next principal queues and replays', async () => {
    const inner = new MemoryLocalStore();
    const warned: unknown[] = [];
    const local: LocalStore = {
      kind: inner.kind,
      rows: (scope) => inner.rows(scope),
      write: (scope, puts, deletes) => inner.write(scope, puts, deletes),
      queue: (scope) => inner.queue(scope),
      writeQueue: (scope, change) => inner.writeQueue(scope, change),
      wipe: async () => {
        throw new DOMException('the transaction was aborted', 'AbortError');
      },
      wipeOthers: (keep) => inner.wipeOthers(keep),
    };
    rescope('u1');
    const sent: string[] = [];
    const outbox = createOutbox({
      local,
      overlays: () => undefined,
      warn: (error) => warned.push(error),
      send: async (queued) => {
        sent.push(queued.key);
        return {};
      },
    });
    await outbox.ready;
    rescope('u2');
    await outbox.ready;
    await outbox.enqueue(entry('u2-like'));
    await outbox.replay();
    expect(sent).toEqual(['u2-like']);
    expect(warned).toEqual([expect.objectContaining({ code: 'X_LOCAL_STORE_UNAVAILABLE' })]);
    // …and a later change still works: the chain was not left on a rejection.
    rescope('u3');
    await outbox.ready;
    await outbox.enqueue(entry('u3-like'));
    expect(outbox.size).toBe(1);
  });

  test('a queue that cannot be OPENED falls back to memory, warned once by code', async () => {
    const inner = new MemoryLocalStore();
    const warned: unknown[] = [];
    const local: LocalStore = {
      kind: inner.kind,
      rows: (scope) => inner.rows(scope),
      write: (scope, puts, deletes) => inner.write(scope, puts, deletes),
      queue: async () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      writeQueue: (scope, change) => inner.writeQueue(scope, change),
      wipe: (scope) => inner.wipe(scope),
      wipeOthers: (keep) => inner.wipeOthers(keep),
    };
    const sent: string[] = [];
    const outbox = createOutbox({
      local,
      principal: () => 'u1',
      overlays: () => undefined,
      warn: (error) => warned.push(error),
      send: async (queued) => {
        sent.push(queued.key);
        return {};
      },
    });
    await outbox.ready;
    await outbox.enqueue(entry('u1-like'));
    expect(outbox.size).toBe(1);
    await outbox.replay();
    expect(sent).toEqual(['u1-like']);
    expect(warned).toEqual([expect.objectContaining({ code: 'X_LOCAL_STORE_UNAVAILABLE' })]);
    // In memory only: nothing was written under the principal.
    expect(await keysOf(inner, 'p:u1')).toEqual([]);
  });
});
