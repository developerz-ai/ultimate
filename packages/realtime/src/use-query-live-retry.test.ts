// A live read's refetch on a REFUSED subscription: a refusal with no `retryAfterSeconds` (a failed
// snapshot read, a timeout) leaves the registration `failed` on an open socket until the socket
// itself reconnects, so a pull-to-refresh that settled at once did nothing in exactly the state a
// user presses it. It re-sends the subscribe and settles once the node has answered.

import { afterEach, describe, expect, test } from 'bun:test';
import { makeCursor } from './cursor';
import { flush, liveFeed, pageHarness, querySids, resetPage } from './hooks-fixture';
import { PROTOCOL_VERSION } from './sync-protocol';
import { useQuery } from './use-query';

const TIMEOUT = { code: 'X_TIMEOUT', cause: 'the snapshot read timed out', fix: 'retry' };

afterEach(() => {
  resetPage();
});

describe('useQuery — a live read refetched after a refusal', () => {
  test('re-subscribes under the same sid and settles when the snapshot lands', async () => {
    const { socket, clock } = pageHarness();
    socket.open();
    const feed = useQuery(liveFeed, null);
    const sid = querySids(socket, 'add')[0] ?? '';
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: TIMEOUT });
    expect(feed().status).toBe('failed');

    let settled = false;
    const refreshed = feed.refetch().then(() => {
      settled = true;
    });
    expect(querySids(socket, 'add')).toEqual([sid, sid]);
    expect(feed()).toEqual({ status: 'pending' });
    await flush();
    expect(settled).toBe(false);

    const rows = [{ id: 'p1' }];
    socket.deliver({
      type: 'snapshot',
      v: PROTOCOL_VERSION,
      sid,
      entity: 'posts',
      rows,
      cursor: makeCursor('liveFeed', '0'.repeat(24), rows, clock.now().getTime()),
    });
    await refreshed;
    expect(feed()).toEqual({ status: 'ready', data: rows });
  });

  test('a second refusal settles it too, failed again — it never hangs', async () => {
    const { socket } = pageHarness();
    socket.open();
    const feed = useQuery(liveFeed, null);
    const sid = querySids(socket, 'add')[0] ?? '';
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: TIMEOUT });
    const refreshed = feed.refetch();
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: TIMEOUT });
    await refreshed;
    expect(feed().status).toBe('failed');
  });

  test('on a closed socket it sends nothing and settles at once: the reopen replays it', async () => {
    const { socket } = pageHarness();
    socket.open();
    const feed = useQuery(liveFeed, null);
    const sid = querySids(socket, 'add')[0] ?? '';
    socket.deliver({ type: 'ack', v: PROTOCOL_VERSION, ref: sid, lsn: null, error: TIMEOUT });
    socket.close(1006);
    expect(await feed.refetch()).toBeUndefined();
    expect(querySids(socket, 'add')).toEqual([sid]);
  });
});
