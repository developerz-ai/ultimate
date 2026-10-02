// The two writes this package sends by NAME — `useMutation` and the outbox replay — post to the
// path the server serves. Neither takes a `pathStyle`: the document carries the server's, and
// core's `actionPath` reads it. Under the default they posted to `/api/posts/like` in a
// `'readable'` app, a path no route served.

import { afterEach, describe, expect, test } from 'bun:test';
import { CLIENT_PATH_STYLE_META } from '@ultimat3/core/page';
import { pageHarness, resetPage } from './hooks-fixture';
import { MemoryLocalStore } from './local-store-idb';
import { createOutbox } from './page-outbox';
import { useMutation } from './use-mutation';

const realFetch = globalThis.fetch;

/** The document a server declaring `style` renders; `undefined` is the default, which stamps nothing. */
const render = (style: string | undefined): void => {
  Reflect.set(globalThis, 'document', {
    querySelector: (selector: string) =>
      selector === `meta[name="${CLIENT_PATH_STYLE_META}"]` && style !== undefined
        ? { content: style }
        : null,
  });
};

/** Every URL dispatched, each answered with an empty success. */
function recordFetch(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return urls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
  Reflect.deleteProperty(globalThis, 'document');
});

describe("a write sent by name, in a 'readable' app", () => {
  test('useMutation posts to the kebab-cased path the server serves', async () => {
    render('readable');
    pageHarness();
    const urls = recordFetch();

    await useMutation({ name: 'likePost' })({ postId: 'p1' });

    expect(urls).toEqual(['/api/like-post']);
  });

  test('the outbox replays a queued write to the same path', async () => {
    render('readable');
    const urls = recordFetch();
    const outbox = createOutbox({ local: new MemoryLocalStore(), principal: () => 'u1' });

    await outbox.enqueue({ key: 'like:1', name: 'likePost', input: { postId: 'p1' } });
    const report = await outbox.replay();

    expect(report.sent).toBe(1);
    expect(urls).toEqual(['/api/like-post']);
  });
});

describe('a write sent by name, in an app that declared no style', () => {
  test("both post under 'resource' — every URL an existing app serves", async () => {
    render(undefined);
    pageHarness();
    const urls = recordFetch();
    const outbox = createOutbox({ local: new MemoryLocalStore(), principal: () => 'u1' });

    await useMutation({ name: 'likePost' })({ postId: 'p1' });
    await outbox.enqueue({ key: 'like:1', name: 'likePost', input: { postId: 'p1' } });
    await outbox.replay();

    expect(urls).toEqual(['/api/posts/like', '/api/posts/like']);
  });
});
