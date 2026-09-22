// The like control the browser actually runs, driven through the real chunk: `mountIsland` builds
// what `x build` and `x dev` build — the realtime bootstrap included — imports it the way the
// hydration runtime does, and runs `mount` against a micro-DOM with a fake `WebSocket` and a fake
// `fetch` in place of the node and the app.
//
// What it proves, in order, over one session:
//   - the island builds no socket of its own: its hooks open the PAGE's one, and join `org-posts`
//     for this org by the declaration's name and params;
//   - the post is seeded as a RECORD from `postRecord`'s record envelope, and the count is that
//     record's, not the prop's;
//   - a click writes the optimistic twin into the store's overlay BEFORE the network answers, and
//     posts `likePost` over HTTP with an idempotency key — the socket carries no writes;
//   - a `records` frame from the channel (another tab's like) moves the count with no refetch;
//   - a refused write takes its overlay back, and the count returns to the server's.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { Frame } from '@ultimat3/realtime';
import { decode, encode, installRealtime, PROTOCOL_VERSION } from '@ultimat3/realtime';
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
  likeCount: 2,
  labels: {
    like: 'Like',
    likes: { locale: 'en', forms: { one: '{count} like', other: '{count} likes' } },
    queued: 'Queued',
    update: 'A new version is ready.',
    reload: 'Reload',
  },
} as const;

const PAGE = Symbol.for('ultimate.realtime');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const row = (likeCount: number) => ({
  id: POST_ID,
  orgId: ORG_ID,
  title: 'A post',
  excerpt: 'about something',
  likeCount,
});

/** Every socket the chunk opened, and every frame it sent on each. */
const opened: FakeSocket[] = [];
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
  deliver(frame: Frame): void {
    this.onmessage?.({ data: encode(frame) });
  }
  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

/** Every request the chunk made, and what the test answers the NEXT like with. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
const calls: Call[] = [];
let likeAnswer: () => Response | Promise<Response> = () => Response.json(row(3));

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(init?.headers).entries());

const fakeFetch = (url: string, init?: RequestInit): Promise<Response> => {
  calls.push({
    url,
    method: init?.method ?? 'GET',
    headers: headersOf(init),
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  if (url.includes('post-record')) {
    return Promise.resolve(
      Response.json(
        { data: [row(2)], records: { posts: { [POST_ID]: row(2) } } },
        { headers: { 'x-ultimate-records': '1' } },
      ),
    );
  }
  return Promise.resolve(likeAnswer());
};

let mounted: MountedIsland;
const count = (): string => mounted.text('[data-role="count"]');

beforeAll(async () => {
  installRealtime({
    signal: <T>(initial: T): [() => T, (next: T) => void] => {
      let held = initial;
      return [() => held, (next) => (held = next)];
    },
    sync: { url: SYNC_URL, buildId: 'build-1' },
  });
  mounted = await mountIsland({
    build: buildIslands,
    root: APP_ROOT,
    file: ISLAND,
    props: PROPS,
    shell: '<div data-role="shell">2 likes</div>',
    globals: { WebSocket: FakeSocket, fetch: fakeFetch },
  });
  await settle();
  opened[0]?.onopen?.();
  await settle();
}, 60_000);

afterAll(() => {
  mounted?.[Symbol.dispose]();
  Reflect.deleteProperty(globalThis, PAGE);
});

describe('the like island', () => {
  test('replaces the shell and opens the page’s ONE socket, joining org-posts for this org', () => {
    expect(mounted.find('[data-role="shell"]')).toBeNull();
    expect(opened).toHaveLength(1);
    const join = opened[0]
      ?.frames()
      .find((frame) => frame.type === 'subscribe' && frame.target.kind === 'channel');
    expect(join?.type === 'subscribe' ? join.target : undefined).toMatchObject({
      kind: 'channel',
      channel: 'org-posts',
      params: { orgId: ORG_ID },
    });
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('seeds the post as a record from postRecord, and shows the record’s count', () => {
    expect(calls.some((call) => call.method === 'GET' && call.url.includes('post-record'))).toBe(
      true,
    );
    expect(count()).toBe('2 likes');
  });

  test('a click is on screen before the server answers, and goes over HTTP with a key', async () => {
    let answer!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetchNow = calls.length;
    // An answer the test holds back: the write is in flight for as long as it wants.
    likeAnswer = () => pending;
    mounted.fire('button', 'click');
    await settle();

    expect(count()).toBe('3 likes');
    const post = calls.slice(fetchNow).find((call) => call.method === 'POST');
    expect(post?.url).toContain('/api/posts/like');
    expect(post?.headers['idempotency-key']).toMatch(/^likePost:/);
    expect(post?.body).toEqual({ postId: POST_ID, orgId: ORG_ID });
    // The socket carried no write.
    expect(opened[0]?.frames().some((frame) => (frame.type as string) === 'mutate')).toBe(false);

    answer(Response.json(row(3)));
    await settle();
    await settle();
  });

  test('a records frame from the channel — another tab’s like — moves the count, no refetch', async () => {
    const before = calls.length;
    opened[0]?.deliver({
      type: 'records',
      v: PROTOCOL_VERSION,
      channel: `org-posts.${ORG_ID}`,
      seq: 1,
      epoch: 'e1',
      adopt: { posts: { [POST_ID]: row(4) } },
    });
    await settle();

    expect(count()).toBe('4 likes');
    expect(calls.length).toBe(before);
  });

  test('a refused write takes its overlay back', async () => {
    // The member's own like is already counted (`likedByMe` is not on the record), so the twin
    // moves the count by one again and the refusal must take exactly that back.
    likeAnswer = () =>
      Response.json(
        { code: 'X_FORBIDDEN', cause: 'denied', fix: 'x policy explain --json' },
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      );
    mounted.fire('button', 'click');
    await settle();
    await settle();

    expect(count()).toBe('4 likes');
  });
});
