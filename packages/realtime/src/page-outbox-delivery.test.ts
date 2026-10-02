// What the page outbox promises about DELIVERY: a queued write is never sent under another
// principal, and it is delivered at least once — resent only until an ack is on disk, never after.
// Every case is gated by hand: no clock, no sleep.

import { afterEach, describe, expect, test } from 'bun:test';
import { clientTransport, rescope } from '@ultimat3/core';
import { type LocalStore, MemoryLocalStore } from './local-store-idb';
import type { QueueChange } from './offline-queue';
import type { OutboxEntry } from './page-outbox';
import { createOutbox } from './page-outbox';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox-locks'));
});

const like = (n: number): OutboxEntry => ({ key: `like:${n}`, name: 'likePost', input: { n } });

/** A send the test releases by hand. */
function gate(): { readonly entered: Promise<void>; open(): void; wait(): Promise<void> } {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    open: () => release(),
    wait: () => {
      enter();
      return released;
    },
  };
}

describe('a principal change while a replay is on the wire', () => {
  test("sends nothing more: the rest of the queue never leaves under the next principal's session", async () => {
    const local = new MemoryLocalStore();
    rescope('u1');
    const first = gate();
    const sent: string[] = [];
    const outbox = createOutbox({
      local,
      overlays: () => undefined,
      send: async (entry) => {
        sent.push(entry.key);
        if (entry.key === 'like:1') await first.wait();
        return {};
      },
    });
    for (const n of [1, 2, 3]) await outbox.enqueue(like(n));
    const pass = outbox.replay();
    await first.entered;

    rescope('u2');
    first.open();
    await pass;
    await outbox.ready;

    expect(sent).toEqual(['like:1']);
    expect(outbox.size).toBe(0);
    // And the pass that was running did not write u1's queue back after the wipe.
    expect((await local.queue('p:u1'))?.mutations ?? []).toEqual([]);
    // u2's replay finds nothing of u1's.
    await outbox.replay();
    expect(sent).toEqual(['like:1']);
  });

  test('a write queued right after the change belongs to the NEW principal', async () => {
    const local = new MemoryLocalStore();
    rescope('u1');
    const sent: string[] = [];
    const outbox = createOutbox({
      local,
      overlays: () => undefined,
      send: async (entry) => {
        sent.push(entry.key);
        return {};
      },
    });
    await outbox.ready;
    rescope('u2');
    // Not awaited first: `enqueue` itself must wait for u2's queue, never write into u1's.
    await outbox.enqueue(like(9));
    expect((await local.queue('p:u2'))?.mutations.map((m) => m.key)).toEqual(['like:9']);
    expect((await local.queue('p:u1'))?.mutations ?? []).toEqual([]);
    await outbox.replay();
    expect(sent).toEqual(['like:9']);
  });
});

describe('a principal change while a write is being queued', () => {
  test('refuses that write by name; the next one goes to the new principal', async () => {
    const inner = new MemoryLocalStore();
    let change: () => void = () => undefined;
    // The queue reads its sequence floor before it stores a write: the principal leaves there.
    const local: LocalStore = {
      kind: inner.kind,
      rows: (scope) => inner.rows(scope),
      write: (scope, puts, deletes) => inner.write(scope, puts, deletes),
      queue: async (scope) => {
        const state = await inner.queue(scope);
        change();
        return state;
      },
      writeQueue: (scope, entry) => inner.writeQueue(scope, entry),
      wipe: (scope) => inner.wipe(scope),
      wipeOthers: (keep) => inner.wipeOthers(keep),
    };
    rescope('u1');
    const outbox = createOutbox({ local, overlays: () => undefined, send: async () => ({}) });
    await outbox.ready;
    change = () => {
      change = () => undefined;
      rescope('u2');
    };
    try {
      await outbox.enqueue(like(1));
      expect.unreachable("u1's write was accepted after u1 left");
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
    }
    await outbox.ready;
    expect(outbox.size).toBe(0);
    expect((await inner.queue('p:u1'))?.mutations ?? []).toEqual([]);

    await outbox.enqueue(like(2));
    expect((await inner.queue('p:u2'))?.mutations.map((m) => m.key)).toEqual(['like:2']);
  });
});

/** The disk as a torn-down document leaves it: a write issued after `tearDown` never lands. */
function tearable(inner: LocalStore): LocalStore & { tearDown(): void } {
  let gone = false;
  return {
    kind: inner.kind,
    rows: (scope) => inner.rows(scope),
    write: (scope, puts, deletes) => inner.write(scope, puts, deletes),
    queue: (scope) => inner.queue(scope),
    writeQueue: (scope: string, change: QueueChange) =>
      gone ? new Promise<void>(() => undefined) : inner.writeQueue(scope, change),
    wipe: (scope) => inner.wipe(scope),
    wipeOthers: (keep) => inner.wipeOthers(keep),
    tearDown: () => {
      gone = true;
    },
  };
}

function document(local: LocalStore, answer: (entry: OutboxEntry) => Promise<unknown>) {
  const sent: string[] = [];
  const outbox = createOutbox({
    local,
    principal: () => 'u1',
    overlays: () => undefined,
    send: (entry) => {
      sent.push(entry.key);
      return answer(entry);
    },
  });
  return { outbox, sent };
}

// At-least-once, by design: the queue entry leaves the disk only when the ack is WRITTEN. A 200
// that reaches a document already being replaced is an ack that never persisted, so the next
// document sends the write again under the SAME idempotency key — and the server answers it from
// its idempotency store (a `mutator()` must be `idempotent: true`), so it applies once.
describe('a 200 that arrives as the document is torn down', () => {
  test('is resent ONCE by the next document, under the same key, and never after its ack is on disk', async () => {
    const disk = new MemoryLocalStore();
    const dying = tearable(disk);
    const first = document(dying, async () => {
      // The response is in; the navigation commits before the ack's transaction does.
      dying.tearDown();
      return { ok: true };
    });
    await first.outbox.enqueue(like(1));
    void first.outbox.replay().catch(() => undefined);
    for (let turn = 0; turn < 20 && first.sent.length === 0; turn += 1) await Promise.resolve();
    expect(first.sent).toEqual(['like:1']);
    // The page is gone, and the browser released the drain lock it held.
    Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox-locks'));
    expect((await disk.queue('p:u1'))?.mutations.map((m) => m.key)).toEqual(['like:1']);

    const second = document(disk, async () => ({ ok: true }));
    await second.outbox.replay();
    expect(second.sent).toEqual(['like:1']);
    expect(second.outbox.size).toBe(0);
    expect((await disk.queue('p:u1'))?.mutations ?? []).toEqual([]);

    // The ack is on disk: no later document, and no later trigger, sends it again.
    await second.outbox.replay();
    const third = document(disk, async () => ({ ok: true }));
    await third.outbox.replay();
    expect(second.sent).toEqual(['like:1']);
    expect(third.sent).toEqual([]);
  });

  test('a replay the server is STILL running (409, in flight) stays queued and is asked again', async () => {
    const disk = new MemoryLocalStore();
    let settled = false;
    // The real transport over a server's real answer: what the outbox sees is what it revives.
    const next = document(disk, (entry) =>
      clientTransport({
        method: 'POST',
        url: 'http://app.test/api/posts/like',
        body: entry.input,
        idempotencyKey: entry.key,
        fetchImpl: async () =>
          settled
            ? Response.json({ ok: true })
            : new Response(
                JSON.stringify({
                  code: 'X_IDEMPOTENCY_CONFLICT',
                  cause: `idempotency key "${entry.key}" is still in flight from an earlier request`,
                  fix: 'resend this request with the same Idempotency-Key once the first one settles',
                }),
                { status: 409, headers: { 'content-type': 'application/problem+json' } },
              ),
      }),
    );
    await next.outbox.enqueue(like(1));
    const report = await next.outbox.replay();
    expect(report.stoppedAt).toBe('like:1');
    expect(next.outbox.size).toBe(1);
    expect((await disk.queue('p:u1'))?.mutations.map((m) => m.status)).toEqual(['pending']);

    settled = true;
    await next.outbox.replay();
    expect(next.sent).toEqual(['like:1', 'like:1']);
    expect(next.outbox.size).toBe(0);
  });
});
