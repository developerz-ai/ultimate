// What a RECEIVED frame does to client state, driven through a real client over the page's
// record store rather than a hand-built target: a patch moves the cursor the next resume is decided
// from, and a refusal lands on the one subscription it names. The socket carries no writes, so an
// `ack` is only ever a refusal.

import { afterEach, describe, expect, test } from 'bun:test';
import { defaultReconnectBudget, makeCursor, shouldResnapshot } from './cursor';
import { liveFeed, type PostRow, pageHarness, querySid, resetPage } from './hooks-fixture';
import { PROTOCOL_VERSION } from './sync-protocol';

const LSN_0 = '0'.repeat(24);
const LSN_1 = '1'.repeat(24);
const DENIED = { code: 'X_FORBIDDEN', cause: 'denied by policy', fix: 'x policy explain --json' };

afterEach(() => {
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
    expect(refused.error()).toEqual(DENIED);
    expect(told).toBe(1);
    expect(fine.state()).toBe('loading');
  });

  test('a refusal naming nothing this client holds is reported, never swallowed', () => {
    const { socket, errors } = pageHarness();
    socket.open();
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: 'sock-1', lsn: null, error: DENIED });
    expect(errors).toEqual([DENIED]);
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
