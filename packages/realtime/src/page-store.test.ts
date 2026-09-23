// The page's boot script opens the outbox with the page: a reload that mounts no live hook and
// makes no write still replays what the previous load queued. And the page store waits on it.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { bootPage } from './boot';
import { resetPage } from './hooks-fixture';
import { pageLocalStore } from './local-store-idb';
import { pageOutbox } from './page-outbox';
import { pageRealtime } from './page-store';

const realFetch = globalThis.fetch;
const host = globalThis as { document?: unknown };

afterEach(() => {
  globalThis.fetch = realFetch;
  delete host.document;
  resetPage();
  rescope(null);
});

describe('the page boot', () => {
  test('replays a queue the previous load left, with no hook and no write on this one', async () => {
    // A principal to persist for — a page rendered for nobody keeps nothing on disk.
    rescope('alice');
    // The previous load: a write the network refused, queued on the page's durable store.
    const previous = pageOutbox();
    await previous.ready;
    await previous.enqueue({ key: 'likePost:k1', name: 'likePost', input: { postId: 'p1' } });
    resetPage(); // the reload: page state and outbox gone, the durable store (`disk`) kept

    const sent: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('idempotency-key'));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    host.document = {}; // a browser page: the outbox replays on open

    // Nothing but the page boot script: no hook, no write, no call to the outbox from here.
    void bootPage();
    await pageRealtime().booted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual(['likePost:k1']);
  });
});

describe('the page store and the boot', () => {
  test('booted is the boot script promise, even for a store an island made first', async () => {
    const page = pageRealtime(); // an island ran before the boot script
    let settled = false;
    void page.booted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true); // no boot script on this page: nothing to wait for

    const boot = bootPage();
    expect(page.booted).toBe(boot);
    expect(bootPage()).toBe(boot); // once per page
  });
});

describe('the boot after a sign-out by full navigation', () => {
  test('wipes every other principal off disk — rows and queued writes — before restoring', async () => {
    const disk = await pageLocalStore();
    await disk.write('p:bob', [{ type: 'posts', key: 'p1', row: { id: 'p1' } }], []);
    await disk.saveQueue('p:bob', { mutations: [], nextSeq: 3 });
    await disk.write('p:alice', [{ type: 'posts', key: 'p2', row: { id: 'p2' } }], []);
    rescope('alice'); // the next page load, rendered for alice; bob never called rescope

    await bootPage();
    expect((await disk.rows('p:bob')).size).toBe(0);
    expect(await disk.queue('p:bob')).toBeUndefined();
    expect((await disk.rows('p:alice')).get('posts')).toBeDefined();
  });

  test('an unscoped page (rendered for nobody) wipes nothing', async () => {
    const disk = await pageLocalStore();
    await disk.write('p:bob', [{ type: 'posts', key: 'p1', row: { id: 'p1' } }], []);
    // A page rendered for nobody: no scope tag, so no principal to keep — and none to wipe for.
    await bootPage({ principal: undefined });
    expect((await disk.rows('p:bob')).get('posts')).toBeDefined();
  });
});

/** A document still parsing, carrying the scope tag the CLI renders beside the boot script. */
const scopedLoadingDocument = {
  readyState: 'interactive',
  querySelector: (selector: string) => (selector.includes('ultimate-scope') ? {} : null),
};

describe('an island that hydrates before the boot script ran', () => {
  // Measured in CI: the idle callback hydrated the like island while the parser still waited on
  // the deferred boot, `booted` answered "done", and a reload offline rebuilt no overlay.
  test('waits on the boot that is coming, and the boot settles it once the outbox is open', async () => {
    host.document = scopedLoadingDocument;
    const page = pageRealtime();
    let settled = false;
    void page.booted.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(Reflect.has(globalThis, Symbol.for('ultimate.outbox'))).toBe(false);

    void bootPage();
    await page.booted;
    expect(settled).toBe(true);
    expect(Reflect.has(globalThis, Symbol.for('ultimate.outbox'))).toBe(true);
  });

  test('on a scoped page whose boot never runs, load settles it rather than waiting forever', async () => {
    host.document = scopedLoadingDocument;
    const page = pageRealtime();
    let settled = false;
    void page.booted.then(() => {
      settled = true;
    });
    dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  test('a partial document with no querySelector (a component test stand-in) is no boot coming', async () => {
    host.document = { readyState: 'interactive' };
    let settled = false;
    void pageRealtime().booted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  test('a page with no scope tag has no boot coming: settled at once', async () => {
    host.document = { readyState: 'interactive', querySelector: () => null };
    let settled = false;
    void pageRealtime().booted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});

describe('a write queued inside the persister debounce', () => {
  // Measured in the reference app: a like taken offline right after the post arrived was queued,
  // but the reload came inside the persister's 250 ms debounce, so the disk held the write and
  // not the post — and the twin, replayed over no row, showed the old count.
  test('reaches the disk after the rows it stands on, never before them', async () => {
    rescope('carol');
    host.document = {
      querySelector: (selector: string) =>
        selector.includes('ultimate-persist') ? { content: 'posts' } : null,
    };
    await bootPage();
    const disk = await pageLocalStore();
    pageRealtime().store.adopt('posts', { p9: { id: 'p9', likes: 1 } });
    expect((await disk.rows('p:carol')).get('posts')).toBeUndefined(); // still debounced

    await pageOutbox().enqueue({ key: 'likePost:k9', name: 'likePost', input: { postId: 'p9' } });
    expect((await disk.rows('p:carol')).get('posts')).toEqual({ p9: { id: 'p9', likes: 1 } });
    expect((await disk.queue('p:carol'))?.mutations.map((entry) => entry.key)).toEqual([
      'likePost:k9',
    ]);
  });
});

describe('a reload taken offline', () => {
  // Measured in the reference app: the boot replayed on open while offline, that POST failed on
  // the wire, and the real one followed on `online` — one write, two requests.
  test('replays nothing on open, then exactly once when the browser is back online', async () => {
    rescope('dora');
    const previous = pageOutbox();
    await previous.ready;
    await previous.enqueue({ key: 'likePost:k7', name: 'likePost', input: { postId: 'p7' } });
    resetPage();

    const sent: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('idempotency-key'));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const navigator = { onLine: false };
    Reflect.set(globalThis, 'navigator', navigator);
    host.document = {};
    try {
      void bootPage();
      await pageRealtime().booted;
      await pageOutbox().ready;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual([]);

      navigator.onLine = true;
      dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent).toEqual(['likePost:k7']);
    } finally {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });
});
