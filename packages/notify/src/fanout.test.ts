// The five things a fan-out has to get right, each with its failure case first: a replay that must
// not send twice, a per-channel opt-out that must not silence the other channels, a bulk channel
// that must send ONE payload, and `if`/`unless` that must be read after the wait rather than before.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryStepStore, resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { createMemoryDeliveryLedger } from './ledger';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver, recorder } from './notify-fixture';
import { createMemoryPreferenceStore } from './preferences';
import { resetNotifyStores, setNotifyStores } from './stores';

const POST = '00000000-0000-7000-8000-00000000beef';
const params: TestParams = { postId: POST };
const audience = [{ id: 'ana' }, { id: 'ben' }];

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

describe('unit · fan-out', () => {
  test('a replayed attempt with no step history does not deliver a second time', async () => {
    // The step store is what an ordinary retry replays from. Throwing it away is the case that
    // matters: the process died, another node claimed the run, and the ONLY thing left saying the
    // email already went out is the ledger.
    const ledger = createMemoryDeliveryLedger();
    setNotifyStores({ ledger });
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.liked:${input.postId}`,
      deliver: [{ channel: log.one('email') }],
    });

    const first = await driver().finish(handle, { params, recipients: audience });
    expect(first.delivered).toBe(2);
    expect(log.sent.map((entry) => entry.to.join())).toEqual(['ana', 'ben']);

    const replay = await driver({ store: createMemoryStepStore() }).finish(handle, {
      params,
      recipients: audience,
    });
    expect(replay.delivered).toBe(0);
    expect(replay.replayed).toBe(2);
    expect(log.sent.length).toBe(2);
  });

  test('an opt-out silences ONE channel and leaves the others firing', async () => {
    const preferences = createMemoryPreferenceStore();
    preferences.deny({ recipient: 'ana', notifier: 'post.commented', channel: 'email' });
    setNotifyStores({ preferences });
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.commented',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.commented:${input.postId}`,
      deliver: [{ channel: log.one('email') }, { channel: log.one('push') }],
    });

    const report = await driver().finish(handle, { params, recipients: audience });

    expect(report.suppressed).toBe(1);
    expect(log.sent.map((entry) => `${entry.channel}:${entry.to.join()}`)).toEqual([
      'email:ben',
      'push:ana',
      'push:ben',
    ]);
  });

  test('a bulk channel sends one payload for the whole audience', async () => {
    setNotifyStores({});
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.flagged',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.flagged:${input.postId}`,
      deliver: [{ channel: log.many('slack') }],
    });

    const report = await driver().finish(handle, {
      params,
      recipients: [...audience, { id: 'cyd' }],
    });

    // ONE call, three addresses — not three calls. That is the whole difference between the two
    // arities, and the reason `noticed` grew the split in the first place.
    expect(log.sent.length).toBe(1);
    expect(log.sent[0]?.to).toEqual(['ana', 'ben', 'cyd']);
    expect(report.delivered).toBe(1);
  });

  test('`if` is evaluated AFTER the wait, so a condition that goes false during it sends nothing', async () => {
    setNotifyStores({});
    const log = recorder();
    let stillWanted = true;
    const handle = notifier<TestParams>({
      name: 'post.reminder',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.reminder:${input.postId}`,
      deliver: [{ channel: log.one('email'), wait: '10m', if: () => stillWanted }],
    });

    const run = driver();
    // Attempt 1 parks on the sleep. If `if` were read before the wait it would already have
    // decided `true` here, and flipping the flag below could not change the outcome.
    expect(await run.once(handle, { params, recipients: audience })).toBeUndefined();
    stillWanted = false;

    const report = await run.finish(handle, { params, recipients: audience });

    expect(log.sent).toEqual([]);
    expect(report.skipped).toBe(2);
    expect(report.delivered).toBe(0);
  });

  test('`unless` is read on the same pass, and a wait that changes nothing still delivers', async () => {
    setNotifyStores({});
    const log = recorder();
    let muted = false;
    const handle = notifier<TestParams>({
      name: 'post.digest-off',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.digest-off:${input.postId}`,
      deliver: [{ channel: log.one('email'), wait: '1h', unless: () => muted }],
    });

    const run = driver();
    expect(await run.once(handle, { params, recipients: [{ id: 'ana' }] })).toBeUndefined();
    const delivered = await run.finish(handle, { params, recipients: [{ id: 'ana' }] });
    expect(delivered.delivered).toBe(1);

    // The mirror, on a fresh notifier: muted before the wake, and nothing goes out.
    muted = true;
    const second = notifier<TestParams>({
      name: 'post.digest-off-2',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.digest-off-2:${input.postId}`,
      deliver: [{ channel: log.one('email2'), wait: '1h', unless: () => muted }],
    });
    const muffled = await driver({ runId: 'run-notify-2' }).finish(second, {
      params,
      recipients: [{ id: 'ana' }],
    });
    expect(muffled.delivered).toBe(0);
    expect(log.sent.map((entry) => entry.channel)).toEqual(['email']);
  });

  test('a declared `recipients` resolver runs on the worker, in a durable step', async () => {
    setNotifyStores({});
    const log = recorder();
    let resolved = 0;
    const handle = notifier<TestParams>({
      name: 'post.subscribed',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `sub:${input.postId}`,
      recipients: ({ input }) => {
        resolved += 1;
        return [{ id: `watcher-of-${input.postId}` }];
      },
      deliver: [{ channel: log.one('email'), wait: '1h' }],
    });

    const run = driver();
    // The audience is resolved on the first attempt and CHECKPOINTED, so the wait cannot change
    // it: whoever subscribes during the hour is a different notification, not this one.
    expect(await run.once(handle, { params })).toBeUndefined();
    await run.finish(handle, { params });

    expect(resolved).toBe(1);
    expect(log.sent[0]?.to).toEqual([`watcher-of-${POST}`]);
  });

  test('an audience wider than the ceiling is refused with both numbers', async () => {
    setNotifyStores({});
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.broadcast',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `broadcast:${input.postId}`,
      maxRecipients: 2,
      deliver: [{ channel: log.one('email') }],
    });

    await expect(
      driver().finish(handle, {
        params,
        recipients: [{ id: 'ana' }, { id: 'ben' }, { id: 'cyd' }],
      }),
    ).rejects.toBeUltimateError('X_NOTIFY_FANOUT_TOO_WIDE');
    expect(log.sent).toEqual([]);
  });

  test('a throwing channel settles `failed`, so the job retry decides and the ledger does not', async () => {
    const ledger = createMemoryDeliveryLedger();
    setNotifyStores({ ledger });
    const log = recorder();
    // A foreign error handed to the code under test is legitimate INPUT, not a test verdict.
    const handle = notifier<TestParams>({
      name: 'post.broken',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `broken:${input.postId}`,
      deliver: [{ channel: log.broken('email', () => new Error('provider 503')) }],
    });

    await expect(
      driver().finish(handle, { params, recipients: [{ id: 'ana' }] }),
    ).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');

    const claim = {
      notifier: 'post.broken',
      key: `broken:${POST}`,
      recipient: 'ana',
      channel: 'email',
    };
    expect((await ledger.find(claim))?.status).toBe('failed');
    // Re-claimable: a failed delivery must not be mistaken for one that already went out.
    expect(await ledger.claim(claim, new Date())).toBe(true);
  });

  test('a channel with no wait fires immediately even when a later one waits an hour', async () => {
    setNotifyStores({});
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.mentioned',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.mentioned:${input.postId}`,
      // Declared out of order on purpose: the fan-out sorts by wait, it does not trust the array.
      deliver: [{ channel: log.one('email'), wait: '1h' }, { channel: log.one('in-app') }],
    });

    const run = driver();
    expect(await run.once(handle, { params, recipients: [{ id: 'ana' }] })).toBeUndefined();
    // The in-app send happened on the FIRST attempt, before the run parked on the email's wait.
    expect(log.sent.map((entry) => entry.channel)).toEqual(['in-app']);

    await run.finish(handle, { params, recipients: [{ id: 'ana' }] });
    expect(log.sent.map((entry) => entry.channel)).toEqual(['in-app', 'email']);
  });
});
