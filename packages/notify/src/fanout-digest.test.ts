// The digest branch under a retry: the append step re-runs WHOLE when one of its appends fails, so
// the recipients it already appended are appended again. Each must still own the window it opened
// and appear in it once — otherwise the window is never drained and its events never sent.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import type { DigestAppend, DigestStore } from './digest';
import { memoryDigestStore } from './digest';
import { NotifyStoreMissingError } from './errors';
import { notifier } from './notifier';
import type { Recorder, TestParams } from './notify-fixture';
import { driver, recorder } from './notify-fixture';
import { resetNotifyStores, setNotifyStores } from './stores';

const params: TestParams = { postId: '00000000-0000-7000-8000-00000000d1d1' };

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

/** A memory store whose first append matching `fails` rejects, once — a dropped connection. */
const flaky = (fails: (input: DigestAppend, call: number) => boolean): DigestStore => {
  const inner = memoryDigestStore();
  let calls = 0;
  let failed = false;
  return {
    append(input) {
      calls += 1;
      if (!failed && fails(input, calls)) {
        failed = true;
        // Any coded error will do: the step runner treats every rejection as a failed attempt.
        return Promise.reject(new NotifyStoreMissingError({ notifier: 'flaky', store: 'digest' }));
      }
      return inner.append(input);
    },
    drain: (slot, endsAt) => inner.drain(slot, endsAt),
  };
};

const digestNotifier = (name: string, log: Recorder) =>
  notifier<TestParams>({
    name,
    input: t.object({ postId: t.uuid }),
    tenant: 'none',
    key: (input) => `${name}:${input.postId}`,
    deliver: [{ channel: log.one('email'), digest: { window: '15m' } }],
  });

describe('unit · fan-out digest under retry', () => {
  test('a second append after a failed first one still drains both', async () => {
    setNotifyStores({ digest: flaky((_, call) => call === 2) });
    const log = recorder();
    const handle = digestNotifier('post.retried-digest', log);
    const run = driver();
    const payload = { params, recipients: [{ id: 'ana' }, { id: 'ben' }] };

    // Attempt one: ana's append opens her window, ben's rejects, and the step fails as a whole.
    await expect(run.once(handle, payload)).rejects.toBeUltimateError('X_NOTIFY_STORE_MISSING');
    const report = await run.finish(handle, payload);

    expect(log.sent.map((entry) => entry.to.join())).toEqual(['ana', 'ben']);
    // Once each: the replayed append joined nothing a second time.
    expect(log.sent.map((entry) => entry.events.length)).toEqual([1, 1]);
    expect(report.delivered).toBe(2);
    expect(report.digested).toBe(0);
  });

  test('a retry after the window it joined was drained does not deliver its event again', async () => {
    // Run two joins ana's window (run one opened it), then fails on ben. Run one flushes the window
    // — ana gets both events — and the row is gone, so nothing the STORE holds remembers that run
    // two's event was in it. Only run two's own step history can.
    setNotifyStores({
      digest: flaky(
        (input) => input.appender.startsWith('run-2:') && input.slot.recipient === 'ben',
      ),
    });
    const log = recorder();
    const handle = digestNotifier('post.drained-digest', log);
    const first = { params, recipients: [{ id: 'ana' }] };
    const second = {
      params: { postId: '00000000-0000-7000-8000-00000000d2d2' },
      recipients: [{ id: 'ana' }, { id: 'ben' }],
    };
    const one = driver({ runId: 'run-1' });
    const two = driver({ runId: 'run-2' });

    expect(await one.once(handle, first)).toBeUndefined();
    await expect(two.once(handle, second)).rejects.toBeUltimateError('X_NOTIFY_STORE_MISSING');
    await one.finish(handle, first);
    // Retried later, so any window it opens closes at a different instant than the drained one —
    // the ledger keys a digest by its window, and must not be what hides a second delivery.
    two.clock.set(one.clock.now().getTime() + 60_000);
    await two.finish(handle, second);

    const sent = log.sent.map((entry) => `${entry.to.join()}:${String(entry.events.length)}`);
    expect(sent).toEqual(['ana:2', 'ben:1']);
  });
});
