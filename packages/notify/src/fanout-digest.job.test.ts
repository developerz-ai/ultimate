// A digest resumed after a suspension sends the `at` a fresh one does. The drained batch comes out
// of a step as JSON, on every attempt, and a channel is promised a `Date`: formatting it used to be
// able to throw on the replay path alone, which is the path nothing tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { installNotifyStores, resetNotifyStores } from './adapter';
import { deliveryChannel } from './channel';
import { memoryDigestStore } from './digest';
import { NotifyStoreMissingError } from './errors';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver, START } from './notify-fixture';

const params: TestParams = { postId: '00000000-0000-7000-8000-00000000d1d1' };
const payload = { params, recipients: [{ id: 'ana' }] };

beforeEach(() => {
  resetJobs();
  installNotifyStores({ digest: memoryDigestStore() });
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

/** A digest whose channel records each `at` it was handed, and rejects its first `blips` calls. */
const digestNotifier = (name: string, blips: number, seen: Date[]) => {
  let calls = 0;
  const channel = deliveryChannel<TestParams>('email', ({ batch }) => {
    calls += 1;
    if (calls <= blips) throw new NotifyStoreMissingError({ notifier: name, store: 'digest' });
    for (const entry of batch) seen.push(entry.at);
  });
  return notifier<TestParams>({
    name,
    input: t.object({ postId: t.uuid }),
    tenant: 'none',
    key: (input) => `${name}:${input.postId}`,
    deliver: [{ channel, digest: { window: '15m' } }],
  });
};

describe('job · a digest keeps its `at` across a resume', () => {
  test('a run resumed after its window suspension and a failed send sends the same at', async () => {
    const seen: Date[] = [];
    const handle = digestNotifier('post.digest-at', 1, seen);
    const run = driver();

    // Attempt 1 opens the window and suspends on its wait.
    expect(await run.once(handle, payload)).toBeUndefined();
    // Attempt 2 wakes, drains into a checkpoint, and the send blips.
    await expect(run.once(handle, payload)).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');
    // Attempt 3 replays that checkpoint: the batch is the stored form, and the channel a `Date`.
    await run.finish(handle, payload);

    expect(seen).toHaveLength(1);
    const [at] = seen;
    expect(at).toBeInstanceOf(Date);
    expect(at?.getTime()).toBe(START);
  });

  test('a run that never failed hands the channel the same instant', async () => {
    const seen: Date[] = [];
    const run = driver();
    await run.finish(digestNotifier('post.digest-fresh', 0, seen), payload);
    expect(seen[0]).toBeInstanceOf(Date);
    expect(seen[0]?.getTime()).toBe(START);
  });

  test('params come back as the notifier declared them, on the first run and on a replay', async () => {
    const seen: unknown[] = [];
    let blips = 1;
    const channel = deliveryChannel<{ when: Date }>('email', ({ batch, event }) => {
      if (blips > 0) {
        blips -= 1;
        throw new NotifyStoreMissingError({ notifier: 'post.digest-params', store: 'digest' });
      }
      seen.push(event.params.when, ...batch.map((entry) => entry.params.when));
    });
    const handle = notifier<{ when: Date }>({
      name: 'post.digest-params',
      input: t.object({ when: t.date }),
      tenant: 'none',
      key: (input) => `post.digest-params:${input.when.getTime()}`,
      deliver: [{ channel, digest: { window: '15m' } }],
    });
    const when = new Date('2026-08-24T09:00:00Z');
    const dated = { params: { when }, recipients: [{ id: 'ana' }] };
    const run = driver<{ when: Date }>();

    expect(await run.once(handle, dated)).toBeUndefined();
    await expect(run.once(handle, dated)).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');
    await run.finish(handle, dated);

    expect(seen).toEqual([when, when]);
    for (const value of seen) expect(value).toBeInstanceOf(Date);
  });

  test('a run with no failure hands the channel Params too', async () => {
    const seen: unknown[] = [];
    const channel = deliveryChannel<{ when: Date }>('email', ({ batch }) => {
      seen.push(...batch.map((entry) => entry.params.when));
    });
    const handle = notifier<{ when: Date }>({
      name: 'post.digest-params-fresh',
      input: t.object({ when: t.date }),
      tenant: 'none',
      key: (input) => `post.digest-params-fresh:${input.when.getTime()}`,
      deliver: [{ channel, digest: { window: '15m' } }],
    });
    const when = new Date('2026-08-24T09:00:00Z');
    await driver<{ when: Date }>().finish(handle, {
      params: { when },
      recipients: [{ id: 'ana' }],
    });
    expect(seen[0]).toBeInstanceOf(Date);
  });
});
