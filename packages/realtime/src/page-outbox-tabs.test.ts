// Two tabs of one user share one durable outbox, and each held its own in-memory copy refreshed
// only inside its own drain. Tab B queued a write, tab A drained and acked it — and B kept saying
// "1 queued" for as long as it stayed open, its listener never told. Each tab now announces its
// own changes, and every other tab re-reads the disk (read-only: no reclaim, no lock needed).

import { afterEach, describe, expect, test } from 'bun:test';
import { memoryLocalStore } from './local-store-idb';
import { type OutboxTabs, outboxTabs } from './outbox-tabs';
import type { OutboxEntry, PageOutbox } from './page-outbox';
import { localOutbox } from './page-outbox';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

const like = (n: number): OutboxEntry => ({ key: `like:${n}`, name: 'likePost', input: { n } });

/** Every tab's `heard`, joined in memory: a post from one reaches every OTHER one, as a channel does. */
function hub() {
  const tabs: ((scope: string | null) => void)[] = [];
  return (heard: (scope: string | null) => void): OutboxTabs => {
    tabs.push(heard);
    return {
      announce: (scope) => {
        for (const other of tabs) if (other !== heard) other(scope);
      },
      stop: () => undefined,
    };
  };
}

/** Lets a refresh the announce started land: it is an awaited disk read. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function twoTabs() {
  const local = memoryLocalStore();
  const tabs = hub();
  const open = (): PageOutbox =>
    localOutbox({
      local,
      principal: () => 'u1',
      send: async () => ({ ok: true }),
      overlays: () => undefined,
      tabs,
    });
  return { a: open(), b: open() };
}

describe('the outbox across tabs', () => {
  test("a write another tab sent leaves this tab's count, and its listener hears it", async () => {
    const { a, b } = twoTabs();
    await Promise.all([a.ready, b.ready]);
    await b.enqueue(like(1));
    await settle();
    const heard: number[] = [];
    b.subscribe(() => heard.push(b.size));
    await a.replay();
    await settle();
    expect(b.size).toBe(0);
    expect(heard).toContain(0);
  });

  test("a write another tab queued joins this tab's count", async () => {
    const { a, b } = twoTabs();
    await Promise.all([a.ready, b.ready]);
    await a.enqueue(like(1));
    await settle();
    expect(b.size).toBe(1);
    expect(b.pending().map((entry) => entry.key)).toEqual(['like:1']);
  });

  test('a fresh read answers before any announce has arrived', async () => {
    const local = memoryLocalStore();
    const quiet = (): OutboxTabs => ({ announce: () => undefined, stop: () => undefined });
    const open = (): PageOutbox =>
      localOutbox({ local, principal: () => 'u1', overlays: () => undefined, tabs: quiet });
    const a = open();
    const b = open();
    await Promise.all([a.ready, b.ready]);
    await a.enqueue(like(1));
    expect(b.size).toBe(0);
    await b.refresh();
    expect(b.size).toBe(1);
  });
});

/** A window with just what `outboxTabs` touches: a channel class and the two page events. */
function fakeWindow() {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    closed = false;
    readonly posted: unknown[] = [];
    constructor(readonly name: string) {
      channels.push(this);
    }
    postMessage(data: unknown): void {
      this.posted.push(data);
    }
    close(): void {
      this.closed = true;
    }
  }
  const events = new EventTarget();
  return {
    channels,
    win: {
      BroadcastChannel: FakeChannel as unknown as typeof BroadcastChannel,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
    fire: (type: string, persisted = false) => {
      const event = new Event(type);
      Object.defineProperty(event, 'persisted', { value: persisted });
      events.dispatchEvent(event);
    },
  };
}

describe('outboxTabs', () => {
  test('announces a scope and hears one, by name', () => {
    const { win, channels } = fakeWindow();
    const heard: (string | null)[] = [];
    const tabs = outboxTabs(win, (scope) => heard.push(scope));
    tabs.announce('u1');
    expect(channels[0]?.name).toBe('ultimate:outbox');
    expect(channels[0]?.posted).toEqual(['u1']);
    channels[0]?.onmessage?.({ data: 'u2' } as MessageEvent);
    channels[0]?.onmessage?.({ data: 42 } as MessageEvent);
    expect(heard).toEqual(['u2']);
  });

  test('closes on pagehide, and a page restored from the cache reopens and re-reads', () => {
    const { win, channels, fire } = fakeWindow();
    const heard: (string | null)[] = [];
    outboxTabs(win, (scope) => heard.push(scope));
    fire('pagehide');
    expect(channels[0]?.closed).toBe(true);
    fire('pageshow', true);
    expect(channels).toHaveLength(2);
    expect(heard).toEqual([null]);
  });

  test('no BroadcastChannel: announcing is a no-op, never a throw', () => {
    const events = new EventTarget();
    const tabs = outboxTabs(
      {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
      () => undefined,
    );
    expect(() => tabs.announce('u1')).not.toThrow();
  });
});
