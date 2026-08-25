// The island the browser actually runs, driven over the real protocol: `mountIsland` builds the
// chunk `x build` and `x dev` build, imports it the way the hydration runtime does, and runs
// `mount` against a micro-DOM with a fake `WebSocket` in place of a sync node.
//
// What it proves is the half `/posts/{id}` never had: a module of this route runs in a browser, a
// click on the like button records the mutation BY NAME and the frame reaches the socket. Before
// this island the page rendered `<LikeButton>` in its own body with no `island()` declared, so
// none of that happened and every click went nowhere, at 200.
//
// The second half is the one a mounting test passes over. `useMutation().pending` reads
// `client.queue` and answers `0` for every mutator when the client has none, so an island that
// boots and sends is still an island whose offline badge can never appear — the same defect,
// relocated. `queues the click while the socket is down` is the case that fails without the
// `OfflineQueue` in `mount`, and it is why this file clicks BEFORE opening the socket.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { Frame } from '@ultimat3/realtime';
import { decode } from '@ultimat3/realtime';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  type MountedIsland,
  mountIsland,
  test,
} from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const ISLAND = 'apps/web/app/posts/[id]/like.island.tsx';
const SYNC_URL = 'ws://localhost:3001';
const POST_ID = '00000000-0000-4000-8000-0000000000c1';
const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

const PROPS = {
  postId: POST_ID,
  orgId: ORG_ID,
  syncUrl: SYNC_URL,
  buildId: 'build-1',
  actorId: '00000000-0000-4000-8000-0000000000bb',
  labels: {
    like: 'Like',
    count: '2 likes',
    queued: 'Queued — this will be sent when you are back online.',
  },
} as const;

/** Every socket the island opened, in order, with the frames it sent on each. */
const opened: FakeSocket[] = [];

/** The `WebSocket` the chunk constructs. Only what `socketFor` in `shared/` touches. */
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

  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

const socket = (): FakeSocket => opened[0] as FakeSocket;

/**
 * What this chunk may weigh: the route's own `budget: { js: '50kb' }` less the 774 bytes of `idle`
 * hydration runtime the document also boots (`hydrateRuntimeBytes`).
 *
 * Asserted here because nothing else can. The `budgets` gate step answers X_BUDGET_UNMEASURED for
 * this route — `.x/build-stats.json` has no row for it, and that pin is not this slice's to close
 * — so between an import added to this island and a page that boots slower than the server render
 * it replaces, there is this line and the 512-byte shaker flap `island-bytes.test.ts` records.
 */
const BUDGET_BYTES = 50 * 1024 - 774;

const mutateFrames = (): readonly Extract<Frame, { type: 'mutate' }>[] =>
  socket()
    .frames()
    .filter((frame): frame is Extract<Frame, { type: 'mutate' }> => frame.type === 'mutate');

/**
 * `mount` is async — the hydration runtime awaits what it returns before marking the element
 * mounted, and `OfflineQueue.open` rehydrates from its store — and `mountIsland` does not await
 * it. One macrotask flushes every microtask behind both that and the click handler, which is also
 * async: `useMutation` awaits the enqueue before it bumps the signal the badge reads.
 */
const settle = (): Promise<void> => Bun.sleep(0);

let mounted: MountedIsland;

beforeAll(async () => {
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: PROPS,
    // What the page server-renders inside the wrapper: the count it read and a button it cannot
    // honour, which is all a server can say about a mutation that travels over a socket.
    shell: '<div data-role="shell">Like</div>',
    globals: { WebSocket: FakeSocket },
  });
  await settle();
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
});

/**
 * One mount, driven as a session — the order below is load-bearing, exactly as
 * `feed.island.test.ts` records: building the real chunk is a Babel pass plus a browser bundle,
 * and each case continues the connection the last one left.
 */
describe('the like island', () => {
  test('opens the sync socket the server named, and replaces the shell', () => {
    expect(opened).toHaveLength(1);
    expect(socket().url).toBe(SYNC_URL);
    // The shell is gone only if `mount` RESOLVED: it is the last thing the async mount does.
    expect(mounted.find('[data-role="shell"]')).toBeNull();
    expect(mounted.text('button')).toBe(PROPS.labels.like);
    expect(mounted.text('[data-role="queued"]')).toBe('');
    // Solid compiles to real DOM calls; a chunk falling back to the classic React factory names a
    // global that is not in it, and `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    // Measured 2026-08-25: 46,658 of 50,426, and 59,846 with `@ultimat3/ui`'s `Button` in it.
    // `TextEncoder`, not `Buffer`: the same measure `hydrateRuntimeBytes` takes, and no `node:`.
    expect(new TextEncoder().encode(mounted.code).byteLength).toBeLessThan(BUDGET_BYTES);
  });

  test('queues the click while the socket is down, and says so on screen', async () => {
    // Nothing has opened the socket, so the client is offline and `drain` sends nothing. Without
    // an `OfflineQueue` on the client this is the case that goes silently wrong: the mutation is
    // written straight to a socket that is not up, `pending` answers 0 because there is no queue
    // to count, and the badge below never renders.
    expect(mounted.fire('button', 'click')).toBe(true);
    await settle();

    expect(mutateFrames()).toHaveLength(0);
    expect(mounted.text('[data-role="queued"]')).toBe(PROPS.labels.queued);
  });

  test('drains the queued mutation by name once the socket opens', async () => {
    socket().open();
    await settle();

    const [mutate] = mutateFrames();
    // The registered mutator name — the one thing that crosses from the server's declaration —
    // and the org the policy decides on, carried in the input rather than read off a session.
    expect(mutate?.name).toBe('likePost');
    expect(mutate?.input).toEqual({ postId: POST_ID, orgId: ORG_ID });
    // Online again, so the badge is not the right thing to say about a mutation in flight.
    expect(mounted.text('[data-role="queued"]')).toBe('');
  });

  test('a click on a live socket is sent once, and not counted as queued', async () => {
    expect(mounted.fire('button', 'click')).toBe(true);
    await settle();

    expect(mutateFrames()).toHaveLength(2);
    expect(mounted.text('[data-role="queued"]')).toBe('');
  });
});
