// The island the browser actually runs, driven over the real protocol: `mountIsland` builds the
// chunk `x build` and `x dev` build — the realtime bootstrap included — imports it the way the
// hydration runtime does, and runs `mount` against a micro-DOM with a fake `WebSocket` in place of
// a sync node.
//
// What it proves: a module of this route runs in a browser, `useQuery` opens the PAGE's one socket
// (the island builds none), subscribes to `liveFeed` BY NAME, and renders the rows the node sends —
// as records, so each row is the store's `posts:<id>` every other island reads.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { Frame } from '@ultimat3/realtime';
import { decode, encode, installRealtime, PROTOCOL_VERSION, pageOutbox } from '@ultimat3/realtime';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const ISLAND = 'apps/web/app/feed/feed.island.tsx';
const SYNC_URL = 'ws://localhost:3001';
const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

const PROPS = {
  orgId: ORG_ID,
  locale: 'en',
  // Not the runtime's zone and not UTC: a date formatted anywhere but the member's zone shows.
  zone: 'Asia/Tokyo',
  labels: {
    empty: 'No posts yet.',
    offline: 'Offline — showing the copy on this device.',
    likes: { locale: 'en', forms: { one: '{count} like', other: '{count} likes' } },
    like: 'Like',
    queued: 'You are offline — this will be sent when you reconnect.',
    update: 'A new version is ready.',
    reload: 'Reload',
  },
  ui: { 'ui.empty': 'Nothing here', 'ui.error.title': 'Something went wrong' },
} as const;

/** The page state every island bundle on a page shares — `globalThis`, by its registered symbol. */
const PAGE = Symbol.for('ultimate.realtime');

/** One turn for the page's disk restore to settle: the socket dials after it (`page-socket.ts`). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Every socket the island opened, in order, with the frames it sent on each. */
const opened: FakeSocket[] = [];

/** The `WebSocket` the chunk constructs. Only what `socketFor` in the island touches. */
class FakeSocket {
  readonly url: string;
  readonly sent: string[] = [];
  readonly bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    opened.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({ code: 1000 });
  }

  open(): void {
    this.onopen?.();
  }

  deliver(frame: Frame): void {
    this.onmessage?.({ data: encode(frame) });
  }

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

const socket = (): FakeSocket => opened[0] as FakeSocket;

const subscribeFrame = (): Extract<Frame, { type: 'subscribe' }> | undefined => {
  for (const frame of socket().frames()) {
    if (frame.type === 'subscribe' && frame.target.kind === 'query') return frame;
  }
  return undefined;
};

let mounted: MountedIsland;

/** Every POST the island made. The network is gone: each one fails the way a browser's does. */
const posted: string[] = [];
const offlineFetch = (url: string | URL | Request): Promise<Response> => {
  posted.push(String(url));
  return Promise.reject(new TypeError('Failed to fetch'));
};

beforeAll(async () => {
  // Where the page's socket dials. A real document names it in `<head>`; the micro-DOM has no head,
  // so the page state is told directly — the same field the bootstrap's `sync` fills.
  installRealtime({
    signal: <T>(initial: T): [() => T, (next: T) => void] => {
      let held = initial;
      return [() => held, (next) => (held = next)];
    },
    sync: { url: SYNC_URL, buildId: 'build-1' },
  });
  // What the page boot does, and the one module that opens the outbox: an island only finds it
  // (`Symbol.for('ultimate.outbox')`), so a page with no boot has none and refuses an offline write.
  pageOutbox();
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: PROPS,
    // What the page server-renders inside the wrapper: the loading state, which is all a server
    // can honestly say about rows only a socket has.
    shell: '<div data-role="shell">Loading the feed</div>',
    globals: { WebSocket: FakeSocket, fetch: offlineFetch },
  });
  await settle();
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
  // The page state is process-global: left behind it would be the next file's page.
  Reflect.deleteProperty(globalThis, PAGE);
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox'));
});

/**
 * One mount, driven as a session — the order below is load-bearing, exactly as
 * `settings.island.test.ts` records: building the real chunk is a Babel pass plus a browser
 * bundle, and each case continues the connection the last one left.
 */
describe('the feed island', () => {
  test('opens the page’s one socket to the node the page named, and replaces the shell', () => {
    expect(opened).toHaveLength(1);
    expect(socket().url.startsWith(SYNC_URL)).toBe(true);
    expect(mounted.find('[data-role="shell"]')).toBeNull();
    // Nothing has answered yet: the region holds its skeleton, never an "empty" nobody said.
    expect(mounted.find('[data-role="posts"]')).toBeNull();
    // Solid compiles to real DOM calls; a chunk falling back to the classic React factory names a
    // global that is not in it, and `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('subscribes to liveFeed by name, for this org', async () => {
    socket().open();
    await settle();

    const hello = socket().frames()[0];
    expect(hello?.type).toBe('hello');
    const subscribe = subscribeFrame();
    expect(subscribe?.target).toMatchObject({
      kind: 'query',
      // The registered query name — the one thing that crosses from the server's declaration.
      qid: 'liveFeed',
      input: { orgId: ORG_ID },
    });
  });

  test('renders the rows the node answers with', async () => {
    const subscribe = subscribeFrame();
    expect(subscribe).toBeDefined();
    socket().deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: subscribe?.sid ?? '',
      rows: [
        {
          id: 'p1',
          title: 'First',
          excerpt: 'one',
          likeCount: 1,
          publishedAt: '2026-03-09T07:30:00.000Z',
          createdAt: '2026-03-08T10:00:00.000Z',
        },
        // Unpublished: the row's date is when it was written. 23:30Z on the 1st is the 2nd in Tokyo.
        {
          id: 'p2',
          title: 'Second',
          excerpt: 'two',
          likeCount: 3,
          publishedAt: null,
          createdAt: '2026-03-01T23:30:00.000Z',
        },
      ],
      cursor: { qid: 'q', lsn: '1', ids: ['p1', 'p2'], at: 0 },
      entity: 'posts',
    });
    await settle();

    // The micro-DOM matches one tag or one attribute — never a descendant — so the list is read
    // by tag, which is exactly what it is: two `<li>`, one link each.
    expect(mounted.find('[data-role="posts"]')).not.toBeNull();
    expect(mounted.all('li')).toHaveLength(2);
    expect(mounted.text('a')).toBe('First');
    expect(mounted.find('a')?.getAttribute('href')).toBe('/posts/p1');
    // Title and like count together, the count phrased by the catalog's own plural forms.
    expect(mounted.all('[data-role="likes"]').map((node) => node.textContent)).toEqual([
      '1 like',
      '3 likes',
    ]);
    // Each row's date in the MEMBER's zone and locale — UTC would say "March 1" for the second.
    expect(mounted.all('time').map((node) => node.textContent)).toEqual([
      'March 9, 2026',
      'March 2, 2026',
    ]);
    // And a like control per row, labelled from the catalog.
    expect(mounted.all('button').map((node) => node.textContent)).toEqual(['Like', 'Like']);
  });

  test('a like the network cannot take waits in the outbox, and the row says so', async () => {
    // Nothing queued yet: the notice is about writes the outbox holds, never about the socket.
    expect(mounted.find('[data-role="queued"]')).toBeNull();
    mounted.fire('button', 'click');
    await settle();
    await settle();

    expect(posted.some((url) => url.endsWith('/api/posts/like'))).toBe(true);
    expect(mounted.text('[data-role="queued"]')).toBe(PROPS.labels.queued);
    // And it IS the boot's outbox that holds it — the notice is a statement about that queue.
    const outbox = pageOutbox();
    await outbox.ready;
    expect(outbox.size).toBe(1);
  });

  test('a result set the node empties is the empty state, not a stuck spinner', async () => {
    socket().deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: subscribeFrame()?.sid ?? '',
      rows: [],
      cursor: { qid: 'q', lsn: '2', ids: [], at: 0 },
      entity: 'posts',
    });
    await settle();

    // `empty` only after the node has ANSWERED. Before the first snapshot the region held its
    // skeleton, which is the difference between "there is nothing" and "nothing has said yet".
    expect(mounted.all('li')).toHaveLength(0);
    expect(mounted.all('p').map((node) => node.textContent)).toContain(PROPS.labels.empty);
  });
});
