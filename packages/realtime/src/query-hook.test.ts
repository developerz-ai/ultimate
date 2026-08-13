// The hook the docs promise: `useLiveFeed({ orgId })`, bound from a real declared
// `query({ live: true })` — so these cases go through `@ultimat3/query` rather than a stand-in.
// The binding's *type* claims live in `type-pins.ts`, not here: `tsconfig.json` excludes test
// files, so a type-level assertion written in this file could never fail.

import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { from, type QueryPolicy, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { type ClientSocket, LiveClient, type SignalFactory } from './client';
import { makeCursor } from './cursor';
import { clearLiveClient, setLiveClient } from './hooks';
import { liveHookFor } from './query-hook';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

/**
 * Deliberately *not* `Row`-shaped: a query's row type is whatever its `sql` returns, and the hook
 * has to carry that one through. A row type constrained to the wire's `JsonObject` would make this
 * declaration — an ordinary interface with no index signature — unbindable.
 */
interface PostRow {
  readonly id: string;
  readonly title: string;
  readonly likes: number;
}

const ROWS: readonly PostRow[] = [
  { id: 'p1', title: 'first', likes: 0 },
  { id: 'p2', title: 'second', likes: 3 },
];

/** Structural, as everywhere else here: authz reaches `@ultimat3/policy` only through `guard`. */
const anyone: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

function declareFeed(options: { live: boolean }) {
  return query({
    input: t.object({ orgId: t.string }),
    policy: anyone,
    ...(options.live ? { live: true } : {}),
    sql: ({ orgId }) =>
      from<PostRow>('posts', async () => ROWS)
        .where({ orgId })
        .orderBy('id')
        .limit(50),
  });
}

const signal: SignalFactory = <T>(initial: T) => {
  let value = initial;
  return [
    () => value,
    (next: T) => {
      value = next;
    },
  ];
};

class FakeSocket implements ClientSocket {
  readonly sent: string[] = [];
  #open: (() => void) | null = null;
  #message: ((data: string) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onOpen(handler: () => void): void {
    this.#open = handler;
  }
  onMessage(handler: (data: string) => void): void {
    this.#message = handler;
  }
  onClose(): void {}

  open(): void {
    this.#open?.();
  }
  deliver(frame: Frame): void {
    this.#message?.(encode(frame));
  }
  frames(): readonly Frame[] {
    return this.sent.map((data) => decode(data));
  }
}

function connected(): { readonly socket: FakeSocket; readonly client: LiveClient } {
  const socket = new FakeSocket();
  const client = new LiveClient({ signal, connect: () => socket, buildId: 'build-1' });
  client.connect();
  socket.open();
  setLiveClient(client);
  return { socket, client };
}

/** The subscribe frame for a query, so a case reads the sid the client minted rather than one it picked. */
function subscribeFrame(socket: FakeSocket): Extract<Frame, { type: 'subscribe' }> | undefined {
  for (const frame of socket.frames()) {
    if (frame.type === 'subscribe' && frame.target.kind === 'query') return frame;
  }
  return undefined;
}

/** Asserting on the code, not the message: the code is the part that is stable forever. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;
  }
  return 'nothing was thrown';
}

beforeEach(() => {
  clearLiveClient();
  resetRegistry();
});

describe('liveHookFor', () => {
  test('binds one query to one named hook, and the hook subscribes under that name', () => {
    const liveFeed = registerQuery('liveFeed', declareFeed({ live: true }));
    const useLiveFeed = liveHookFor(liveFeed);
    const { socket } = connected();

    const feed = useLiveFeed({ orgId: 'o1' });

    const frame = subscribeFrame(socket);
    expect(frame?.op).toBe('add');
    expect(frame?.target).toMatchObject({ kind: 'query', qid: 'liveFeed', input: { orgId: 'o1' } });
    expect(feed()).toEqual([]);
  });

  test('reads the name at call time, so a binding written above registration still subscribes', () => {
    // The order an app actually runs in: `export const useLiveFeed = liveHookFor(liveFeed)` is a
    // module-level binding, and `registerQueries()` stamps the name later, at boot.
    const declared = declareFeed({ live: true });
    const useLiveFeed = liveHookFor(declared);
    expect(declared.name).toBe('');

    registerQuery('liveFeed', declared);
    const { socket } = connected();
    useLiveFeed({ orgId: 'o1' });

    expect(subscribeFrame(socket)?.target).toMatchObject({ qid: 'liveFeed' });
  });

  test('the snapshot lands on the accessor in the query’s own row type', () => {
    const liveFeed = registerQuery('liveFeed', declareFeed({ live: true }));
    const useLiveFeed = liveHookFor(liveFeed);
    const { socket } = connected();
    const feed = useLiveFeed({ orgId: 'o1' });
    const sid = subscribeFrame(socket)?.sid ?? '';

    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows: [{ id: 'p1', title: 'first', likes: 0 }],
      cursor: makeCursor('liveFeed', '1', [{ id: 'p1' }], 1_000),
    });

    // `title` typechecks because the row type came off the declaration — that is the assertion.
    expect(feed()[0]?.title).toBe('first');
    expect(feed.state()).toBe('live');
    expect(feed.cursor()?.qid).toBe('liveFeed');
  });

  test('a thunk input is read once, at subscribe time — never again', () => {
    const liveFeed = registerQuery('liveFeed', declareFeed({ live: true }));
    const useLiveFeed = liveHookFor(liveFeed);
    connected();
    let reads = 0;

    const feed = useLiveFeed(() => {
      reads += 1;
      return { orgId: 'o1' };
    });
    feed();
    feed();

    expect(reads).toBe(1);
  });

  test('unsubscribe is the caller’s, and it drops the subscription it opened', () => {
    const liveFeed = registerQuery('liveFeed', declareFeed({ live: true }));
    const { socket } = connected();

    const feed = liveHookFor(liveFeed)({ orgId: 'o1' });
    const sid = subscribeFrame(socket)?.sid ?? '';
    feed.unsubscribe();

    const dropped = socket
      .frames()
      .find((frame) => frame.type === 'subscribe' && frame.op === 'drop');
    expect(dropped?.type === 'subscribe' && dropped.sid).toBe(sid);
  });

  test('a query that is not live: true is refused where the binding is written', () => {
    const plain = registerQuery('orgPosts', declareFeed({ live: false }));
    expect(codeOf(() => liveHookFor(plain))).toBe('X_QUERY_NOT_SUBSCRIBABLE');
  });

  test('the refusal names the query before registration has stamped one', () => {
    try {
      liveHookFor(declareFeed({ live: false }));
      expect.unreachable('expected the binding to be refused');
    } catch (error) {
      expect(error instanceof UltimateError && error.cause).toContain('<unregistered>');
    }
  });

  test('a bound hook called with no client registered is X_LIVE_CLIENT_MISSING, not a default', () => {
    const liveFeed = registerQuery('liveFeed', declareFeed({ live: true }));
    const useLiveFeed = liveHookFor(liveFeed);
    expect(codeOf(() => useLiveFeed({ orgId: 'o1' }))).toBe('X_LIVE_CLIENT_MISSING');
  });
});
