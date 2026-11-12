// A drain (the run's signal aborting) in the middle of a chunk: every send already claimed settles
// before the step answers, and nothing new is claimed. A step that answered at once left up to 16
// rows `sending` behind a process about to exit — each re-sent by the retry after its window.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock } from '@ultimat3/core';
import { memoryStepStore, resetJobs, stepRunner } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { installNotifyStores, resetNotifyStores } from './adapter';
import { deliveryChannel } from './channel';
import { NOTIFY_DELIVERY_WIDTH } from './fanout-walk';
import type { DeliveryLedger } from './ledger';
import { memoryDeliveryLedger } from './ledger';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { START } from './notify-fixture';

beforeEach(() => resetJobs());
afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

const yieldTurns = async (turns: number): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

describe('unit · a drain mid-chunk', () => {
  test('waits for every send in flight to settle, and claims nothing after the abort', async () => {
    const inner = memoryDeliveryLedger();
    const counts = { claimed: 0, settled: 0 };
    const ledger: DeliveryLedger = {
      claim: async (claim, at) => {
        counts.claimed += 1;
        return inner.claim(claim, at);
      },
      settle: async (claim, status, at, claimId) => {
        counts.settled += 1;
        return inner.settle(claim, status, at, claimId);
      },
      find: (claim) => inner.find(claim),
    };
    installNotifyStores({ ledger });

    // Every send waits on one gate the test opens: the abort lands with the width in flight.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let inFlight = 0;
    const channel = deliveryChannel<TestParams>('push', async () => {
      inFlight += 1;
      await gate;
    });
    const handle = notifier<TestParams>({
      name: 'post.drained',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.drained:${input.postId}`,
      maxRecipients: 100,
      deliver: [{ channel }],
    });

    const clock = frozenClock(START);
    const drain = new AbortController();
    const runner = stepRunner({
      runId: 'run-drain',
      jobName: handle.name,
      store: memoryStepStore(),
      clock,
      signal: drain.signal,
    });
    let answered = false;
    const run = Promise.resolve(
      handle.run({
        input: {
          params: { postId: '00000000-0000-7000-8000-00000000beef' },
          recipients: Array.from({ length: 40 }, (_, index) => ({ id: `r${String(index)}` })),
        },
        step: runner.step,
        ctx: ctxOf({ clock }),
        attempt: 1,
        finalAttempt: false,
        progress: () => undefined,
        jobId: 'job-drain',
        runId: 'run-drain',
      }),
    ).then(
      () => 'resolved',
      () => 'rejected',
    );
    void run.then(() => {
      answered = true;
    });

    await yieldTurns(500);
    expect(inFlight).toBe(NOTIFY_DELIVERY_WIDTH);
    drain.abort();
    await yieldTurns(500);
    // The sends are still running: the step must not have answered over them.
    expect(answered).toBe(false);

    open();
    expect(await run).toBe('rejected');
    // Every claim was settled; none past the width was taken after the abort.
    expect(counts.claimed).toBe(NOTIFY_DELIVERY_WIDTH);
    expect(counts.settled).toBe(NOTIFY_DELIVERY_WIDTH);
  });
});
