// The re-proof against a slow pool: its deadline runs from the SEND, and a send the pool has not
// answered by then is no verdict — a saturated pool must not un-prove a healthy wake. Time is the
// injected `setTimer`; the pool is held and released by hand.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installLogSink } from '@ultimat3/core';
import { JOBS_WAKE_CHANNEL, OUTBOX_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD } from './driver-pg-wake-sql';
import { setWakeLive, wakeIsLive } from './enqueue-signal';
import { startQueueWake } from './queue-wake';
import { type Scripted, scripted, settle } from './queue-wake-fixture';

const events: string[] = [];
let releaseLogSink: () => void = () => undefined;

beforeEach(() => {
  events.length = 0;
  releaseLogSink = installLogSink((line) => {
    const parsed = JSON.parse(line) as { msg?: string; event?: string };
    events.push(parsed.msg ?? parsed.event ?? line);
  });
});

afterEach(() => {
  releaseLogSink();
  setWakeLive(false);
});

const lost = (): number => events.filter((event) => event === 'jobs.wake.lost').length;
const REPROOF = [
  [JOBS_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD],
  [OUTBOX_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD],
] as const;

/** A wake proven by its first probe, its first re-proof armed, and the pool then saturated. */
async function provenThenStalled(): Promise<{
  script: Scripted;
  wake: ReturnType<typeof startQueueWake>;
  release: () => void;
}> {
  const script = scripted();
  const wake = startQueueWake({ ...script, verifyTimeoutMs: 5_000, reproveEveryMs: 10_000 });
  await settle();
  script.notify(JOBS_WAKE_CHANNEL, '');
  script.notify(OUTBOX_WAKE_CHANNEL, '');
  expect(wakeIsLive()).toBe(true);
  expect(script.pending()).toEqual([10_000]);
  const release = script.stall();
  script.fire();
  await settle();
  return { script, wake, release };
}

describe('a re-proof on a pool that does not answer', () => {
  test('its deadline is armed when it is SENT, not when the pool answers', async () => {
    const { script, wake, release } = await provenThenStalled();
    // The pool holds the statements; the verdict is already counting.
    expect(script.pending()).toEqual([5_000]);
    release();
    await settle();
    expect(script.probes.slice(2)).toEqual([...REPROOF]);
    // Sent and answered, and nothing crossed inside the window that began at the send.
    script.fire();
    expect(wakeIsLive()).toBe(false);
    expect(lost()).toBe(1);
    await wake.stop();
  });

  test('a saturated pool past the deadline does not un-prove a healthy session', async () => {
    const { script, wake, release } = await provenThenStalled();
    script.fire();
    // No verdict: the notification never left the pool. Nothing more is piled onto it.
    expect(wakeIsLive()).toBe(true);
    expect(lost()).toBe(0);
    expect(script.pending()).toEqual([]);
    // The late answer is void and asks again at once; the healthy session hears it.
    release();
    await settle();
    expect(script.probes.slice(2)).toEqual([...REPROOF, ...REPROOF]);
    expect(script.pending()).toEqual([5_000]);
    script.notify(JOBS_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD);
    script.notify(OUTBOX_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD);
    expect(wakeIsLive()).toBe(true);
    expect(lost()).toBe(0);
    expect(script.pending()).toEqual([10_000]);
    await wake.stop();
  });

  test('a dead session behind a saturated pool is un-proven one window after the pool answers', async () => {
    const { script, wake, release } = await provenThenStalled();
    script.fire();
    expect(wakeIsLive()).toBe(true);
    release();
    await settle();
    // The fresh proof's own window, from its own send; nothing crosses a dead session.
    expect(script.pending()).toEqual([5_000]);
    script.fire();
    expect(wakeIsLive()).toBe(false);
    expect(lost()).toBe(1);
    expect(script.pending()).toEqual([10_000]);
    await wake.stop();
  });

  test("a peer's notification answers a stalled proof, and its late send asks nothing more", async () => {
    const { script, wake, release } = await provenThenStalled();
    script.notify(JOBS_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD);
    script.notify(OUTBOX_WAKE_CHANNEL, WAKE_REPROVE_PAYLOAD);
    expect(script.pending()).toEqual([10_000]);
    release();
    await settle();
    expect(script.probes.slice(2)).toEqual([...REPROOF]);
    expect(script.pending()).toEqual([10_000]);
    expect(wakeIsLive()).toBe(true);
    await wake.stop();
  });
});
