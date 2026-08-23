// The island the browser actually runs, driven over the real protocol: `mountIsland` builds the
// chunk `x build` and `x dev` build, imports it the way the hydration runtime does, and runs
// `mount` against a micro-DOM with a fake `WebSocket` in place of a sync node.
//
// What it proves is the half `/feed` never had (#271): a module of this route runs in a browser,
// registers a `LiveClient`, subscribes to `liveFeed` BY NAME, and renders the rows the node sends
// back. Before this island the page read the live query in its own body, so none of that happened
// and the feed rendered its loading branch forever, at 200.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { Frame } from '@ultimat3/realtime';
import { decode, encode, PROTOCOL_VERSION } from '@ultimat3/realtime';
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
  syncUrl: SYNC_URL,
  buildId: 'build-1',
  actorId: '00000000-0000-4000-8000-0000000000bb',
  orgId: ORG_ID,
  labels: {
    loading: 'Loading the feed',
    empty: 'No posts yet.',
    offline: 'Offline — showing the copy on this device.',
  },
} as const;

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

beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: PROPS,
    // What the page server-renders inside the wrapper: the loading state, which is all a server
    // can honestly say about rows only a socket has.
    shell: '<div data-role="shell">Loading the feed</div>',
    globals: { WebSocket: FakeSocket },
  });
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
});

/**
 * One mount, driven as a session — the order below is load-bearing, exactly as
 * `settings.island.test.ts` records: building the real chunk is a Babel pass plus a browser
 * bundle, and each case continues the connection the last one left.
 */
describe('the feed island', () => {
  test('opens the sync socket the server named, and replaces the shell', () => {
    expect(opened).toHaveLength(1);
    expect(socket().url).toBe(SYNC_URL);
    expect(mounted.find('[data-role="shell"]')).toBeNull();
    // Nothing has answered yet, so the island says what it knows: still loading.
    expect(mounted.text('[data-role="loading"]')).toBe(PROPS.labels.loading);
    // Solid compiles to real DOM calls; a chunk falling back to the classic React factory names a
    // global that is not in it, and `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('subscribes to liveFeed by name, for this org', () => {
    socket().open();

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

  test('renders the rows the node answers with', () => {
    const subscribe = subscribeFrame();
    expect(subscribe).toBeDefined();
    socket().deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: subscribe?.sid ?? '',
      rows: [
        { id: 'p1', title: 'First', excerpt: 'one', likeCount: 0 },
        { id: 'p2', title: 'Second', excerpt: 'two', likeCount: 3 },
      ],
      cursor: { qid: 'q', lsn: '1', digest: 'd', ids: ['p1', 'p2'], count: 2, at: 0 },
    });

    expect(mounted.find('[data-role="loading"]')).toBeNull();
    // The micro-DOM matches one tag or one attribute — never a descendant — so the list is read
    // by tag, which is exactly what it is: two `<li>`, one link each.
    expect(mounted.find('[data-role="posts"]')).not.toBeNull();
    expect(mounted.all('li')).toHaveLength(2);
    expect(mounted.text('a')).toBe('First');
    expect(mounted.find('a')?.getAttribute('href')).toBe('/posts/p1');
  });

  test('a result set the node empties is the empty state, not a stuck spinner', () => {
    socket().deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid: subscribeFrame()?.sid ?? '',
      rows: [],
      cursor: { qid: 'q', lsn: '2', digest: 'd', ids: [], count: 0, at: 0 },
    });

    // `empty` only after the node has ANSWERED. Before the first snapshot the same branch says
    // `loading`, which is the difference between "there is nothing" and "nothing has said yet".
    expect(mounted.all('li')).toHaveLength(0);
    expect(mounted.text('[data-role="empty"]')).toBe(PROPS.labels.empty);
  });
});
