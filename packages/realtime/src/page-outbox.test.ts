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

describe('replay triggers that arrive together', () => {
  // Open, `online`, the socket's reconnect and the service worker's drain can all land in one
  // moment. Each used to chain a pass of its own, and a pass whose send failed left the entry
  // pending for the next — four triggers, four POSTs of one write.
  test('join the replay in flight: a failing write is attempted once, not once per trigger', async () => {
    const { outbox, sent, answerWith } = setup('u1');
    await outbox.enqueue(like(1));
    answerWith(async () => {
      throw offline();
    });
    await Promise.all([outbox.replay(), outbox.replay(), outbox.replay(), outbox.replay()]);
    expect(sent.map((entry) => entry.key)).toEqual(['like:1']);
    expect(outbox.size).toBe(1); // still queued for the next trigger
  });

  test('and a write that lands is sent exactly once per entry, in order', async () => {
    const { outbox, sent } = setup('u1');
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    await Promise.all([outbox.replay(), outbox.replay(), outbox.replay(), outbox.replay()]);
    expect(sent.map((entry) => entry.key)).toEqual(['like:1', 'like:2']);
    expect(outbox.size).toBe(0);
  });

  test('a replay the browser knows cannot leave sends nothing, whoever asked', async () => {
    const { outbox, sent } = setup('u1');
    await outbox.enqueue(like(1));
    Reflect.set(globalThis, 'navigator', { onLine: false });
    try {
      const report = await outbox.replay();
      expect(sent).toEqual([]);
      expect(report.remaining).toBe(1);
    } finally {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
    await outbox.replay();
    expect(sent.map((entry) => entry.key)).toEqual(['like:1']);
  });

  test('a replay after the joined one finished is a pass of its own', async () => {
    const { outbox, sent, answerWith } = setup('u1');
    await outbox.enqueue(like(1));
    answerWith(async () => {
      throw offline();
    });
    await outbox.replay();
    answerWith(async () => ({ ok: true }));
    await outbox.replay();
    expect(sent.map((entry) => entry.key)).toEqual(['like:1', 'like:1']);
    expect(outbox.size).toBe(0);
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

  test('while the browser says it is offline, no signal replays — the attempt could only fail', () => {
    const worker = new EventTarget();
    const navigator = { serviceWorker: worker, onLine: false };
    Reflect.set(globalThis, 'navigator', navigator);
    let replays = 0;
    const stop = listenForDrain({
      replay: async () => {
        replays += 1;
        return { sent: 0, collapsed: 0, remaining: 0, stoppedAt: null };
      },
    });
    try {
      worker.dispatchEvent(
        Object.assign(new Event('message'), { data: { type: OUTBOX_DRAIN_MESSAGE } }),
      );
      expect(replays).toBe(0);
      navigator.onLine = true;
      globalThis.dispatchEvent(new Event('online'));
      expect(replays).toBe(1);
    } finally {
      stop();
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});

// Two tabs of one user each kept an in-memory copy of the outbox and saved it WHOLE, so the last
// save won and the other tab's queued write was gone. One record per mutation key now.
describe('two tabs, one outbox', () => {
  test('both tabs queue offline, and a reload sends both writes, in order', async () => {
    const local = new MemoryLocalStore();
    const tabA = setup('u1', local);
    const tabB = setup('u1', local);
    await tabA.outbox.ready;
    await tabB.outbox.ready;
    await tabA.outbox.enqueue(like(1));
    await tabB.outbox.enqueue(like(2));

    const reloaded = setup('u1', local);
    await reloaded.outbox.replay();
    expect(reloaded.sent.map((entry) => entry.key)).toEqual(['like:1', 'like:2']);
    expect(reloaded.outbox.size).toBe(0);
  });

  test('a tab replays what ANOTHER tab queued since it opened', async () => {
    const local = new MemoryLocalStore();
    const tabA = setup('u1', local);
    const tabB = setup('u1', local);
    await tabA.outbox.ready;
    await tabB.outbox.enqueue(like(7));
    await tabA.outbox.replay();
    expect(tabA.sent.map((entry) => entry.key)).toEqual(['like:7']);
    // ...and once sent it is gone for every tab: tab B's next replay sends nothing.
    await tabB.outbox.replay();
    expect(tabB.sent).toEqual([]);
  });

  // A write saved as `inflight` belonged to a page that is gone. It was never resent after a
  // reload, and every later write overtook it.
  test('a write a closed page left inflight is sent first after the reload', async () => {
    const local = new MemoryLocalStore();
    const first = setup('u1', local);
    let hang: (() => void) | undefined;
    first.answerWith(
      () =>
        new Promise(() => {
          hang = () => undefined;
        }),
    );
    await first.outbox.enqueue(like(1));
    void first.outbox.replay();
    for (let turn = 0; turn < 20 && hang === undefined; turn += 1) await Promise.resolve();
    expect(hang).toBeDefined();
    // Queued while like:1 is on the wire: this save is what wrote like:1 to disk as `inflight`.
    await first.outbox.enqueue(like(2));
    // The page closes: the browser releases the drain lock it held, mid-send.
    Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox-locks'));

    const reloaded = setup('u1', local);
    await reloaded.outbox.replay();
    expect(reloaded.sent.map((entry) => entry.key)).toEqual(['like:1', 'like:2']);
  });
});
