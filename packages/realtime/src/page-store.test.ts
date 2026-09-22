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
