// The digest window, as the thing it exists for: N events for one recipient over one channel
// become ONE delivery. Driven through two concurrent runs of the same notifier, because that is
// what actually happens — a window is opened by one job and appended to by the next.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { createMemoryDigestStore } from './digest';
import type { NotifyEvent } from './notification';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver, recorder } from './notify-fixture';
import { resetNotifyStores, setNotifyStores } from './stores';

const FIRST = '00000000-0000-7000-8000-000000000001';
const SECOND = '00000000-0000-7000-8000-000000000002';
const ana = [{ id: 'ana' }];

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

describe('unit · digest window', () => {
  test('two events inside one window become ONE delivery carrying both', async () => {
    setNotifyStores({ digest: createMemoryDigestStore() });
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.commented',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `comment:${input.postId}`,
      deliver: [{ channel: log.one('email'), digest: { window: '15m' } }],
    });

    // Run one opens the window and parks on it.
    const opener = driver({ runId: 'run-open' });
    expect(
      await opener.once(handle, { params: { postId: FIRST }, recipients: ana }),
    ).toBeUndefined();
    expect(log.sent).toEqual([]);

    // Run two lands inside the same window: it appends and finishes, delivering nothing itself.
    const joiner = await driver({ runId: 'run-join' }).finish(handle, {
      params: { postId: SECOND },
      recipients: ana,
    });
    expect(joiner.digested).toBe(1);
    expect(joiner.delivered).toBe(0);
    expect(log.sent).toEqual([]);

    // The opener wakes and flushes both.
    const flushed = await opener.finish(handle, { params: { postId: FIRST }, recipients: ana });
    expect(flushed.delivered).toBe(1);
    expect(log.sent.length).toBe(1);
    expect(log.sent[0]?.events).toEqual([`comment:${FIRST}`, `comment:${SECOND}`]);
  });

  test('a window whose time has passed is RE-OPENED rather than appended to', async () => {
    // Its owner is gone — a crashed flush — so an append would sit there until an unrelated third
    // event arrived. Re-opening costs one extra delivery instead of losing one.
    const store = createMemoryDigestStore();
    const slot = { recipient: 'ana', notifier: 'n', channel: 'email', group: 'g' };
    const event: NotifyEvent = { notifier: 'n', key: 'k1', params: {}, at: new Date(0) };
    const first = await store.append({ slot, event, windowMs: 1_000, now: new Date(0) });
    expect(first).toEqual({ opened: true, endsAt: 1_000 });
    expect(store.open).toBe(1);

    expect((await store.append({ slot, event, windowMs: 1_000, now: new Date(500) })).opened).toBe(
      false,
    );
    expect(
      (await store.append({ slot, event, windowMs: 1_000, now: new Date(2_000) })).opened,
    ).toBe(true);

    // Draining closes the bucket, and a drained slot answers empty rather than undefined.
    expect(await store.drain(slot)).toHaveLength(1);
    expect(await store.drain(slot)).toEqual([]);
    store.clear();
    expect(store.open).toBe(0);
  });

  test('a digest window with no store installed refuses by name', async () => {
    setNotifyStores({});
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `like:${input.postId}`,
      deliver: [{ channel: log.one('email'), digest: { window: '1h' } }],
    });

    const run = driver();
    await expect(
      run.finish(handle, { params: { postId: FIRST }, recipients: ana }),
    ).rejects.toBeUltimateError('X_NOTIFY_STORE_MISSING');
  });

  test('a digest declared on a bulk channel is refused where it is written', () => {
    const log = recorder();
    expect(() =>
      notifier<TestParams>({
        name: 'post.flagged',
        input: t.object({ postId: t.uuid }),
        tenant: 'none',
        key: (input) => `flag:${input.postId}`,
        deliver: [{ channel: log.many('slack'), digest: { window: '1h' } }],
      }),
    ).toThrow(/X_NOTIFY_DIGEST_UNSUPPORTED|digest window/);
  });
});
