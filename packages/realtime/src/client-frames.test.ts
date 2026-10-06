// What a RECEIVED frame does to client state, driven through a real client over the page's
// record store rather than a hand-built target: a patch moves the cursor the next resume is decided
// from, and a refusal lands on the one subscription it names. The socket carries no writes, so an
// `ack` is only ever a refusal.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, writeDigest } from '@ultimat3/core';
import { LiveClient } from './client';
import { defaultReconnectBudget, makeCursor, shouldResnapshot } from './cursor';
import {
  FakeSocket,
  flush,
  liveFeed,
  type PostRow,
  pageHarness,
  querySid,
  querySids,
  resetPage,
} from './hooks-fixture';
import type { LocalTx } from './record-tx';
import { type PatchFrame, PROTOCOL_VERSION } from './sync-protocol';
import { type MutatorLike, useMutation } from './use-mutation';

const LSN_0 = '0'.repeat(24);
const LSN_1 = '1'.repeat(24);
const DENIED = { code: 'X_FORBIDDEN', cause: 'denied by policy', fix: 'x policy explain --json' };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

describe('a patch frame', () => {
  // `cursor.at` only ever moved on a snapshot, so `shouldResnapshot`'s lag check answered
  // "re-snapshot" for every client connected longer than `maxLagMs` — the delta resume the
  // retained change window exists for, dead exactly during the deploy storm it was built for.
  test('advances the cursor, so a long-lived subscription can still resume from a delta', async () => {
    const { client, socket, clock } = pageHarness();
    socket.open();
    const handle = client.subscribeLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const sid = querySid(socket, 'add');
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 2 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', LSN_0, rows, clock.now().getTime()),
    });

    clock.advance(defaultReconnectBudget.maxLagMs + 60_000);
    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: LSN_1,
      patches: [
        { op: 'insert', id: 'p2', row: { id: 'p2', likedByMe: false, likeCount: 0 }, lsn: LSN_1 },
      ],
    });

    const cursor = handle.cursor();
    expect(cursor?.lsn).toBe(LSN_1);
    expect(cursor?.at).toBe(clock.now().getTime());
    expect([...(cursor?.ids ?? [])]).toEqual(['p1', 'p2']);
    // The property all of that is for: this cursor is still resumable.
    const decision = shouldResnapshot(
      cursor ?? makeCursor('liveFeed', LSN_0, rows, 0),
      [],
      clock.now().getTime(),
    );
    expect(decision).toEqual({ resnapshot: false, reason: 'in-window', cost: 0 });
  });

  test('a tier-1 channel frame carries no lsn, so it never rewinds a cursor', async () => {
    const { client, socket, clock } = pageHarness();
    socket.open();
    const handle = client.subscribeLive<PostRow>(liveFeed, { orgId: 'org-1' });
    const sid = querySid(socket, 'add');
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 2 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      rows,
      cursor: makeCursor('liveFeed', LSN_1, rows, clock.now().getTime()),
    });

    socket.deliver({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: '',
      patches: [{ op: 'update', id: 'p1', row: { likeCount: 3 }, lsn: '' }],
    });

    expect(handle.cursor()?.lsn).toBe(LSN_1);
  });
});

describe('an ack carrying an error', () => {
  test('fails the ONE subscription it names, and no other', () => {
    const { client, socket } = pageHarness();
    socket.open();
    const refused = client.subscribeLive<PostRow>(liveFeed, { orgId: 'o1' });
    const fine = client.subscribeLive<PostRow>({ name: 'other' }, null);
    const sid = querySid(socket, 'add');
    let told = 0;
    refused.onChange(() => {
      told += 1;
    });

    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: DENIED });

    expect(refused.state()).toBe('failed');
    // The node's own error, BRANDED: a plain `{ code, cause, fix }` object fails `isUltimateError`,
    // so an error screen rendered it as `X_INTERNAL` with the real error JSON-stringified into its
    // cause and a fix telling the reader to throw the `UltimateError` it already was.
    const error = refused.error();
    expect(isUltimateError(error)).toBe(true);
    expect(error).toMatchObject({ ...DENIED, meta: { origin: 'remote' } });
    expect(told).toBe(1);
    expect(fine.state()).toBe('loading');
  });

  test('a refusal naming nothing this client holds is reported, never swallowed', () => {
    const { socket, errors } = pageHarness();
    socket.open();
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: 'sock-1', lsn: null, error: DENIED });
    expect(errors).toHaveLength(1);
    expect(isUltimateError(errors[0])).toBe(true);
    expect(errors[0]).toMatchObject(DENIED);
  });

  test('a refused subscription stays failed when the socket drops, not offline', () => {
    const { client, socket } = pageHarness();
    socket.open();
    const handle = client.subscribeLive<PostRow>(liveFeed, { orgId: 'o1' });
    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: querySid(socket, 'add'),
      lsn: null,
      error: DENIED,
    });
    socket.close(1006);
    expect(handle.state()).toBe('failed');
  });
});

// A rate-limited registration is not a denial: the node said when the bucket refills. Left
// `failed`, it stayed dead until the socket happened to reconnect.
describe('a rate-limited subscription', () => {
  const LIMITED = { ...DENIED, code: 'X_RATE_LIMITED', retryAfterSeconds: 3 };

  const rig = () => {
    const socket = new FakeSocket();
    const armed: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
    const client = new LiveClient({
      connect: () => socket,
      buildId: 'build-1',
      catchUp: async () => undefined,
      clock: frozenClock(1_000),
      rng: () => 0,
      heartbeatMs: 0,
      scheduler: (run, delayMs) => {
        const timer = { run, delayMs, cancelled: false };
        armed.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      onError: () => {},
    });
    client.connect();
    socket.open();
    return { socket, client, armed };
  };

  test('re-subscribes after the delay the node named, under the same sid', () => {
    const { socket, client, armed } = rig();
    const handle = client.subscribeLive<PostRow>(liveFeed, { orgId: 'o1' });
    const sid = querySid(socket, 'add');
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: LIMITED });
    expect(handle.state()).toBe('failed');
    const retry = armed.find((timer) => timer.delayMs === 3_000);
    expect(retry).toBeDefined();
    retry?.run();
    expect(querySids(socket, 'add')).toEqual([sid, sid]);
    expect(handle.state()).toBe('loading');
  });

  test('a denial schedules nothing, and an unsubscribe cancels a pending retry', () => {
    const { socket, client, armed } = rig();
    const denied = client.subscribeLive<PostRow>(liveFeed, { orgId: 'o1' });
    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: querySid(socket, 'add'),
      lsn: null,
      error: DENIED,
    });
    expect(armed.filter((timer) => timer.delayMs === 3_000)).toHaveLength(0);
    denied.unsubscribe();

    const limited = client.subscribeLive<PostRow>(liveFeed, { orgId: 'o2' });
    const sid = querySids(socket, 'add')[1] ?? '';
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: LIMITED });
    limited.unsubscribe();
    expect(armed.find((timer) => timer.delayMs === 3_000)?.cancelled).toBe(true);
  });
});

describe('a records frame', () => {
  test('writes the store for every holder in one batch; an events frame never touches it', () => {
    const { page, socket, client } = pageHarness();
    socket.open();
    client.holdChannel(
      {
        name: 'org-feed',
        catchUp: 'orgFeed',
        topic: (p: Readonly<Record<'orgId', string>>) => `org-feed.${p.orgId}`,
      },
      { orgId: 'o1' },
    );
    page.store.adopt('posts', { p9: { id: 'p9' } });
    let batches = 0;
    page.store.subscribe(() => {
      batches += 1;
    });

    socket.deliver({
      type: 'records',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      seq: 1,
      epoch: 'e1',
      adopt: { posts: { p1: { id: 'p1', title: 'hello' } } },
      remove: { posts: ['p9'] },
    });
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'hello' });
    expect(page.store.peek('posts', 'p9')).toBeUndefined();
    expect(batches).toBe(1);

    socket.deliver({
      type: 'events',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      event: { id: 'p1', title: 'NOT a record' },
    });
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'hello' });
    expect(batches).toBe(1);
  });
});

// A live window over a row this page is writing. The node commits, fans the change out and only
// then answers the POST, so the patch routinely beats the answer — and merged under the write's
// still-pending overlay, the window painted the write twice (truth + overlay: a like counted 3
// times for one member's one like) until the answer settled it.
describe('a patch frame naming the write that produced it', () => {
  const LIKE: MutatorLike = {
    name: 'likePost',
    local(tx: LocalTx, input: { readonly postId: string }) {
      tx['posts']?.update(input.postId, (post) => ({ likeCount: Number(post['likeCount']) + 1 }));
    },
  };

  /** A held POST: "the patch arrived before the answer" is then a state, not a race. */
  function heldKeys(): string[] {
    const keys: string[] = [];
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('idempotency-key') ?? '');
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    return keys;
  }

  async function likedWindow() {
    const harness = pageHarness();
    const { client, socket, clock } = harness;
    socket.open();
    const handle = client.subscribeLive<PostRow>(liveFeed, { orgId: 'o1' });
    const sid = querySid(socket, 'add');
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 1 }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', LSN_0, rows, clock.now().getTime()),
    });
    const keys = heldKeys();
    void useMutation(LIKE)({ postId: 'p1' });
    await flush();
    // Every like count the window rendered, one entry per notification.
    const painted: number[] = [];
    harness.page.store.subscribe(() => {
      painted.push(Number(handle.rows()[0]?.likeCount));
    });
    const echo = (writes?: readonly string[]): PatchFrame => ({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid,
      lsn: LSN_1,
      patches: [{ op: 'update', id: 'p1', row: { likeCount: 2 }, lsn: LSN_1 }],
      ...(writes === undefined ? {} : { writes }),
    });
    const write = await writeDigest(keys[0] ?? '');
    if (write === undefined)
      expect.unreachable('Bun ships WebCrypto, so a digest is always minted');
    return { ...harness, handle, painted, echo, write, sid };
  }

  test('settles the write in the same batch: the window never shows truth plus overlay', async () => {
    const { page, socket, handle, painted, echo, write } = await likedWindow();
    expect(handle.rows()[0]?.likeCount).toBe(2);
    expect(page.store.pending()).toHaveLength(1);

    socket.deliver(echo([write]));

    expect(page.store.pending()).toEqual([]);
    expect(handle.rows()[0]?.likeCount).toBe(2);
    expect(painted).not.toContain(3);
    expect(painted).toHaveLength(1);
  });

  test('an echo naming no write is truth UNDER the overlay: the twin replays on top', async () => {
    const { page, socket, handle, echo } = await likedWindow();

    socket.deliver(echo());

    // The double count this frame field exists to remove — the control that proves the test above
    // is measuring the settle and not something else.
    expect(page.store.pending()).toHaveLength(1);
    expect(handle.rows()[0]?.likeCount).toBe(3);
  });

  test('a snapshot naming the write settles it in the same batch too', async () => {
    const { page, socket, handle, painted, write, sid } = await likedWindow();
    const rows: readonly PostRow[] = [{ id: 'p1', likedByMe: false, likeCount: 2 }];

    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', LSN_1, rows, 0),
      writes: [write],
    });

    expect(page.store.pending()).toEqual([]);
    expect(handle.rows()[0]?.likeCount).toBe(2);
    expect(painted).not.toContain(3);
    expect(painted).toHaveLength(1);
  });

  test('a digest this page never pushed changes nothing', async () => {
    const { page, socket, handle, echo } = await likedWindow();

    socket.deliver(echo(['f'.repeat(32)]));

    expect(page.store.pending()).toHaveLength(1);
    expect(handle.rows()[0]?.likeCount).toBe(3);
  });
});
