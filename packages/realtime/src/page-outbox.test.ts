import { afterEach, describe, expect, test } from 'bun:test';
import { OUTBOX_DRAIN_MESSAGE, rescope, UltimateError } from '@ultimat3/core';
import { MemoryLocalStore } from './local-store-idb';
import type { OutboxEntry, OutboxOverlays } from './page-outbox';
import { createOutbox, listenForDrain } from './page-outbox';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

const offline = (): UltimateError =>
  new UltimateError({
    code: 'X_CLIENT_TRANSPORT_FAILED',
    cause: 'the network dropped it',
    fix: 'retry',
    retry: 'retryable',
  });

const refused = (): UltimateError =>
  new UltimateError({ code: 'X_FORBIDDEN', cause: 'no', fix: 'ask for access' });

function overlays(): OutboxOverlays & { settled: string[]; dropped: string[] } {
  const settled: string[] = [];
  const dropped: string[] = [];
  return { settled, dropped, settle: (key) => settled.push(key), drop: (key) => dropped.push(key) };
}

function setup(principal: string | null | undefined, local = new MemoryLocalStore()) {
  const sent: OutboxEntry[] = [];
  let answer: (entry: OutboxEntry) => Promise<unknown> = async () => ({ ok: true });
  const twins = overlays();
  const outbox = createOutbox({
    local,
    principal: () => principal,
    send: (entry) => {
      sent.push(entry);
      return answer(entry);
    },
    overlays: () => twins,
  });
  return {
    outbox,
    local,
    sent,
    twins,
    answerWith: (next: (entry: OutboxEntry) => Promise<unknown>) => {
      answer = next;
    },
  };
}

const like = (n: number): OutboxEntry => ({ key: `like:${n}`, name: 'likePost', input: { n } });

describe('the page outbox', () => {
  test('replays in order, each under its own idempotency key, and empties as the server takes them', async () => {
    const { outbox, sent, twins } = setup('u1');
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    expect(outbox.size).toBe(2);
    const report = await outbox.replay();
    expect(sent.map((entry) => entry.key)).toEqual(['like:1', 'like:2']);
    expect(report.sent).toBe(2);
    expect(outbox.size).toBe(0);
    expect(twins.settled).toEqual(['like:1', 'like:2']);
  });

  test('a queued write survives a reload and replays exactly once', async () => {
    const local = new MemoryLocalStore();
    const first = setup('u1', local);
    first.answerWith(async () => Promise.reject(offline()));
    await first.outbox.enqueue(like(1));
    await first.outbox.replay();
    expect(first.outbox.size).toBe(1);

    const reloaded = setup('u1', local);
    await reloaded.outbox.replay();
    await reloaded.outbox.replay();
    expect(reloaded.sent.map((entry) => entry.key)).toEqual(['like:1']);
    expect(reloaded.outbox.size).toBe(0);
  });

  test('the network failing stops the pass and keeps everything, in order', async () => {
    const { outbox, sent, answerWith } = setup('u1');
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    answerWith(async () => Promise.reject(offline()));
    const report = await outbox.replay();
    expect(sent.map((entry) => entry.key)).toEqual(['like:1']);
    expect(report.stoppedAt).toBe('like:1');
    expect(outbox.size).toBe(2);
  });

  test('a server refusal is final: kept for the UI, never resent, its twin taken back', async () => {
    const { outbox, sent, twins, answerWith } = setup('u1');
    await outbox.enqueue(like(1));
    answerWith(async () => Promise.reject(refused()));
    await outbox.replay();
    await outbox.replay();
    expect(sent).toHaveLength(1);
    expect(twins.dropped).toEqual(['like:1']);
    expect(outbox.size).toBe(0);
  });

  test("a principal change wipes the previous principal's queue — never sent as the next", async () => {
    const local = new MemoryLocalStore();
    rescope('u1');
    const outbox = createOutbox({ local, send: async () => ({}), overlays: () => undefined });
    await outbox.enqueue(like(1));
    rescope('u2');
    await outbox.ready;
    expect(outbox.size).toBe(0);
    expect(await local.queue('p:u1')).toBeUndefined();
  });

  test('an unscoped page queues in memory only: a reload finds nothing', async () => {
    const local = new MemoryLocalStore();
    const first = setup(undefined, local);
    first.answerWith(async () => Promise.reject(offline()));
    await first.outbox.enqueue(like(1));
    const reloaded = setup(undefined, local);
    await reloaded.outbox.ready;
    expect(reloaded.outbox.size).toBe(0);
  });
});

describe('listenForDrain', () => {
  test("the service worker's drain message and coming back online both replay", () => {
    const worker = new EventTarget();
    Reflect.set(globalThis, 'navigator', { serviceWorker: worker });
    let replays = 0;
    const stop = listenForDrain({
      replay: async () => {
        replays += 1;
        return { sent: 0, collapsed: 0, remaining: 0, stoppedAt: null };
      },
    });
    try {
      worker.dispatchEvent(
        Object.assign(new Event('message'), { data: { type: 'something-else' } }),
      );
      expect(replays).toBe(0);
      worker.dispatchEvent(
        Object.assign(new Event('message'), { data: { type: OUTBOX_DRAIN_MESSAGE } }),
      );
      globalThis.dispatchEvent(new Event('online'));
      expect(replays).toBe(2);
    } finally {
      stop();
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
