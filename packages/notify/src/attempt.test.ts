// claim → send → settle, and what each answer of the claim asks of an attempt. The one that matters
// is `held`: read as "already sent", a holder that then dies is a notification nobody retries.

import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { isUltimateError, logger } from '@ultimat3/core';
import { nextRetryForError } from '@ultimat3/jobs';
import { type AttemptInput, attemptDelivery } from './attempt';
import { memoryDeliveryLedger } from './ledger';
import { NotifyPushProviderRefusedError } from './push-errors';

const NOW = new Date('2026-08-24T09:00:00Z');
const claim = { notifier: 'post.liked', key: 'k1', recipient: 'ana', channel: 'email' };
const warned = spyOn(logger, 'warn');

beforeEach(() => warned.mockClear());
afterAll(() => warned.mockRestore());

const rig = (reclaimAfterMs = 60_000) => {
  const ledger = memoryDeliveryLedger({ reclaimAfterMs });
  let at = NOW;
  const sends: string[] = [];
  const input = (
    name: string,
    send: AttemptInput['send'] = () => {
      sends.push(name);
    },
  ): AttemptInput => ({
    ledger,
    claim,
    notifier: claim.notifier,
    channel: claim.channel,
    recipients: 1,
    ctx: { now: () => at },
    send,
  });
  return {
    ledger,
    sends,
    input,
    advance: (ms: number) => {
      at = new Date(at.getTime() + ms);
    },
  };
};

const attempt = (input: AttemptInput): Promise<boolean> =>
  attemptDelivery(input, new AbortController().signal);

/** A send the test finishes by hand: an attempt caught mid-flight. */
const heldSend = () => {
  let finish: (failure?: unknown) => void = () => undefined;
  const send = new Promise<void>((resolve, reject) => {
    finish = (failure) => (failure === undefined ? resolve() : reject(failure));
  });
  return { send: () => send, finish };
};

describe('unit · one delivery attempt', () => {
  test('sends once, and a replay of a settled delivery answers false', async () => {
    const app = rig();
    expect(await attempt(app.input('first'))).toBe(true);
    expect(await attempt(app.input('replay'))).toBe(false);
    expect(app.sends).toEqual(['first']);
  });

  test('a second attempt beside a live one does not send, and is not told it went out', async () => {
    const app = rig();
    const slow = heldSend();
    const first = attempt(app.input('first', slow.send));
    await Bun.sleep(0);
    app.advance(15_000);

    const refusal = await attempt(app.input('second')).catch((error: unknown) => error);

    if (!isUltimateError(refusal)) return expect.unreachable('a held claim raises');
    expect(refusal.code).toBe('X_NOTIFY_DELIVERY_HELD');
    // Rounded up, plus one: a retry landing exactly on the edge of the window is refused again.
    expect(refusal.meta?.['retryAfterSeconds']).toBe(46);
    expect(app.sends).toEqual([]);
    slow.finish();
    expect(await first).toBe(true);
  });

  test('the refusal is waited out: the retry lands past the window, not on the backoff', async () => {
    const app = rig();
    void attempt(app.input('first', () => new Promise(() => undefined)));
    await Bun.sleep(0);

    const refusal = await attempt(app.input('second')).catch((error: unknown) => error);

    const decision = nextRetryForError(
      { attempts: 3, delay: 1, backoff: 'fixed', jitter: false, maxDelay: 3_600_000 },
      1,
      refusal,
    );
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(61_000);
  });

  test('a crashed attempt is re-sent by a retry past the window', async () => {
    const app = rig();
    void attempt(app.input('crashed', () => new Promise(() => undefined)));
    await Bun.sleep(0);
    app.advance(60_001);

    expect(await attempt(app.input('retry'))).toBe(true);
    expect(app.sends).toEqual(['retry']);
    expect((await app.ledger.find(claim))?.status).toBe('sent');
  });

  test('a late attempt that fails cannot move its reclaimer back, and says so', async () => {
    const app = rig();
    const slow = heldSend();
    const late = attempt(app.input('late', slow.send));
    await Bun.sleep(0);
    app.advance(60_001);
    expect(await attempt(app.input('retry'))).toBe(true);

    slow.finish(new TypeError('provider 503'));
    await expect(late).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');

    expect((await app.ledger.find(claim))?.status).toBe('sent');
    expect(warned.mock.calls.filter(([line]) => line === 'notify.settle_fenced')).toHaveLength(1);
  });

  test('a refusal classified terminal stays terminal through the wrapper, and the row re-claimable', async () => {
    const app = rig();
    const refused = new NotifyPushProviderRefusedError({
      provider: 'apns',
      status: 403,
      reason: 'x',
    });
    const failure = await attempt(
      app.input('refused', () => {
        throw refused;
      }),
    ).catch((error: unknown) => error);

    if (!isUltimateError(failure)) return expect.unreachable('a throwing channel raises');
    expect(failure.code).toBe('X_NOTIFY_DELIVERY_FAILED');
    const policy = { attempts: 5, delay: 1, backoff: 'fixed', jitter: false } as const;
    expect(nextRetryForError(policy, 1, failure)).toMatchObject({
      retry: false,
      stoppedBy: 'terminal',
    });
    expect((await app.ledger.find(claim))?.status).toBe('failed');
  });

  test('a channel blip stays retryable through the wrapper', async () => {
    const app = rig();
    const blip = new TypeError('provider 503'); // the channel's input, not this test's verdict
    const failure = await attempt(
      app.input('blip', () => {
        throw blip;
      }),
    ).catch((error: unknown) => error);
    const policy = { attempts: 5, delay: 1, backoff: 'fixed', jitter: false } as const;
    expect(nextRetryForError(policy, 1, failure)).toMatchObject({ retry: true });
  });

  test('an attempt that owns its row settles it with no warning', async () => {
    const app = rig();
    expect(await attempt(app.input('only'))).toBe(true);
    expect(warned.mock.calls.filter(([line]) => line === 'notify.settle_fenced')).toEqual([]);
  });
});
