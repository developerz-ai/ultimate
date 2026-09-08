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
//
// The THIRD half is the one nothing in this repository had ever executed: the optimistic twin.
// `recordMutation` applies it under `if (store && local && !collapsed)`, no app passed a
// `LocalStore`, so the count on screen never moved until a reload. Two cases pin the pair that
// turns it on, and each fails for a different deletion — take the `store` out of `mount` and the
// count stays put on the click; take the `log` out and the count never comes BACK when the server
// refuses the write, because `rollbackFailed` returns early without both.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { Frame } from '@ultimat3/realtime';
import { decode, encode, PROTOCOL_VERSION, toWireError } from '@ultimat3/realtime';
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
  /** The server's count, as the page reads it. The twin can only ever take this to 3. */
  likeCount: 2,
  syncUrl: SYNC_URL,
  buildId: 'build-1',
  actorId: '00000000-0000-4000-8000-0000000000bb',
  labels: {
    like: 'Like',
    count: '2 likes',
    countWithMine: '3 likes',
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
const BUDGET_BYTES = 56 * 1024 - 774;

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

/** What the node answers a mutation it will not apply — today's `x dev` answers exactly this. */
const refuse = (key: string): void => {
  socket().onmessage?.({
    data: encode({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: key,
      lsn: null,
      error: toWireError({
        code: 'X_NOT_IMPLEMENTED',
        cause: 'this sync node was started without a mutation handler',
        fix: 'pass onMutate to createSyncNode({ onMutate })',
      }),
    }),
  });
};

const countText = (): string => mounted.text('[data-role="count"]');

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
    // Nothing has been clicked, so the local row still holds the count the server rendered.
    expect(countText()).toBe(PROPS.labels.count);
    // Solid compiles to real DOM calls; a chunk falling back to the classic React factory names a
    // global that is not in it, and `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    // Measured 2026-09-08: 52,824 of 56,570 — 48,972 of it the island as it stood before tier 3
    // was turned on, and 3,852 the store, the log and the signal that reads the optimistic row.
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
    // The whole point of tier 3, executed for the first time in this repository: no socket, no
    // server, no round trip, and the member's own like is already on screen. Without the
    // `MemoryLocalStore` in `mount` this reads `2 likes` — `recordMutation` skips `store.apply`
    // and there is no optimistic row anywhere.
    expect(countText()).toBe(PROPS.labels.countWithMine);
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
    // Sending changes nothing on screen: the twin already said it, and an accepted write must not
    // flicker.
    expect(countText()).toBe(PROPS.labels.countWithMine);
  });

  test('a click on a live socket is sent once, and not counted as queued', async () => {
    expect(mounted.fire('button', 'click')).toBe(true);
    await settle();

    expect(mutateFrames()).toHaveLength(2);
    expect(mounted.text('[data-role="queued"]')).toBe('');
    // Convergent, through the real client this time and not a fake `LocalTx`: the second twin
    // reads `likedByMe` and writes nothing, so one member is one like however often they press.
    expect(countText()).toBe(PROPS.labels.countWithMine);
  });

  /**
   * The rollback path, and it is the path a running Postly takes TODAY: `x dev` builds its sync
   * node with no `onMutate` (`packages/cli/src/dev-sync.ts` passes none), so every `mutate` frame
   * comes back as an `ack` carrying `X_NOT_IMPLEMENTED`. An optimistic write with nothing to take
   * it back would leave a like on screen that no server ever accepted.
   *
   * Both keys, oldest first, because that is what the reconcile rule makes observable: refusing
   * the first rolls back everything from its sequence onward and REPLAYS the second, so the count
   * is still `3 likes` in between. Only when the second is refused too is there no optimistic
   * write left, and the row is the one the server rendered.
   */
  test('a refused write is taken back off the screen', async () => {
    const [first, second] = mutateFrames();
    expect(first?.key).toBeString();
    expect(second?.key).toBeString();

    refuse(first?.key ?? '');
    await settle();
    // Not yet: the second like is still pending, and rollback replays what it undid around it.
    expect(countText()).toBe(PROPS.labels.countWithMine);

    refuse(second?.key ?? '');
    await settle();
    // The pre-mutation count, restored from the journal `MemoryLocalStore` kept under each key.
    // Without the `RebaseLog` in `mount` this stays `3 likes` for ever: `rollbackFailed` returns
    // early when either half of the pair is missing.
    expect(countText()).toBe(PROPS.labels.count);
  });
});
