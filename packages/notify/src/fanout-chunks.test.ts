// A big audience in bounded round trips. One preference read per recipient per channel and one
// durable step per recipient made a 10k fan-out 20k+ reads and 10k `x_job_steps` rows; the walk
// now reads preferences one chunk at a time (`allowsMany`) and delivers one chunk per step, named
// by the chunk's place in the audience the `open` step froze — stable across a replay.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { classifyThrown, isUltimateError } from '@ultimat3/core';
import { memoryStepStore, resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { installNotifyStores, resetNotifyStores } from './adapter';
import { deliveryChannel } from './channel';
import { memoryDigestStore } from './digest';
import { NOTIFY_CHUNK_SIZE, NOTIFY_DELIVERY_WIDTH } from './fanout-walk';
import { memoryDeliveryLedger } from './ledger';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver, RUN_ID, recorder } from './notify-fixture';
import type { PreferenceBatchQuery, PreferenceStore } from './preferences';
import { NotifyPushProviderRefusedError } from './push-errors';

const POST = '00000000-0000-7000-8000-00000000beef';
const params: TestParams = { postId: POST };
const AUDIENCE = 10_000;
const recipients = Array.from({ length: AUDIENCE }, (_, index) => ({ id: `r${String(index)}` }));

// A foreign failure handed to the subject: test input, never its verdict.
const PROVIDER_503 = new RangeError('provider 503');

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

/** Counts reads per channel; denies every id in `denied`. */
const countingPreferences = (denied: ReadonlySet<string> = new Set()) => {
  const reads = new Map<string, number>();
  const sizes: number[] = [];
  const store: PreferenceStore = {
    allowsMany(query: PreferenceBatchQuery) {
      reads.set(query.channel, (reads.get(query.channel) ?? 0) + 1);
      sizes.push(query.recipients.length);
      return query.recipients.map((r) => r.id).filter((id) => !denied.has(id));
    },
  };
  return { store, reads, sizes };
};

const handleFor = (log: ReturnType<typeof recorder>) =>
  notifier<TestParams>({
    name: 'post.announced',
    input: t.object({ postId: t.uuid }),
    tenant: 'none',
    key: (input) => `post.announced:${input.postId}`,
    maxRecipients: AUDIENCE,
    deliver: [{ channel: log.one('email') }, { channel: log.one('push') }],
  });

describe('unit · a 10k audience fans out in bounded round trips', () => {
  test('preference reads ≤ 2 × ⌈10k/chunk⌉ per channel, each read ≤ one chunk', async () => {
    const prefs = countingPreferences();
    installNotifyStores({ preferences: prefs.store });
    const log = recorder();
    const report = await driver().finish(handleFor(log), { params, recipients });
    const bound = 2 * Math.ceil(AUDIENCE / NOTIFY_CHUNK_SIZE);
    expect(prefs.reads.get('email')).toBeLessThanOrEqual(bound);
    expect(prefs.reads.get('push')).toBeLessThanOrEqual(bound);
    expect(Math.max(...prefs.sizes)).toBeLessThanOrEqual(NOTIFY_CHUNK_SIZE);
    expect(report.delivered).toBe(2 * AUDIENCE);
    expect(log.sent.length).toBe(2 * AUDIENCE);
  });

  test('durable steps per channel are ⌈10k/chunk⌉, not one per recipient', async () => {
    installNotifyStores({});
    const store = memoryStepStore();
    await driver({ store }).finish(handleFor(recorder()), { params, recipients });
    const names = (await store.list(RUN_ID)).map((record) => record.name);
    const deliver = names.filter((name) => name.startsWith('deliver:email'));
    expect(deliver.length).toBe(Math.ceil(AUDIENCE / NOTIFY_CHUNK_SIZE));
    expect(names.length).toBeLessThanOrEqual(1 + 2 * Math.ceil(AUDIENCE / NOTIFY_CHUNK_SIZE));
  });

  test('step names are stable across a replay, and a replay sends nothing', async () => {
    // Two channels × 10k claims: past the memory ledger's default cap, which would evict.
    const ledger = memoryDeliveryLedger({ max: 2 * AUDIENCE });
    installNotifyStores({ ledger });
    const log = recorder();
    const handle = handleFor(log);
    const first = memoryStepStore();
    await driver({ store: first }).finish(handle, { params, recipients });
    const second = memoryStepStore();
    const replay = await driver({ store: second }).finish(handle, { params, recipients });
    const namesOf = async (store: typeof first) =>
      (await store.list(RUN_ID)).map((record) => record.name).sort();
    expect(await namesOf(second)).toEqual(await namesOf(first));
    expect(replay.delivered).toBe(0);
    expect(replay.replayed).toBe(2 * AUDIENCE);
    expect(log.sent.length).toBe(2 * AUDIENCE);
  });

  test('a recipient denied in one chunk is suppressed on that channel only', async () => {
    const denied = new Set(['r0', `r${String(NOTIFY_CHUNK_SIZE + 1)}`]);
    const prefs = countingPreferences(denied);
    installNotifyStores({ preferences: prefs.store });
    const log = recorder();
    const report = await driver().finish(handleFor(log), { params, recipients });
    expect(report.suppressed).toBe(2 * denied.size);
    expect(log.sent.some((entry) => denied.has(entry.to[0] ?? ''))).toBe(false);
  });

  test('an id the store answers that is not in the chunk admits nobody extra', async () => {
    installNotifyStores({
      preferences: { allowsMany: (query) => ['intruder', ...query.recipients.map((r) => r.id)] },
    });
    const log = recorder();
    await driver().finish(handleFor(log), { params, recipients: recipients.slice(0, 3) });
    expect(log.sent.map((entry) => entry.to.join())).not.toContain('intruder');
  });
});

describe('unit · a digest fan-out reads preferences per chunk and sends per chunk', () => {
  const DIGEST_AUDIENCE = 2 * NOTIFY_CHUNK_SIZE + 1;

  test('reads ≤ 2 per chunk; one send step per chunk; append and drain stay per recipient', async () => {
    const prefs = countingPreferences();
    installNotifyStores({ preferences: prefs.store, digest: memoryDigestStore() });
    const log = recorder();
    const handle = notifier<TestParams>({
      name: 'post.digested',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.digested:${input.postId}`,
      maxRecipients: DIGEST_AUDIENCE,
      deliver: [{ channel: log.one('email'), digest: { window: '15m' } }],
    });
    const store = memoryStepStore();
    const report = await driver({ store }).finish(handle, {
      params,
      recipients: recipients.slice(0, DIGEST_AUDIENCE),
    });
    const chunks = Math.ceil(DIGEST_AUDIENCE / NOTIFY_CHUNK_SIZE);
    expect(prefs.reads.get('email')).toBeLessThanOrEqual(2 * chunks);
    const names = (await store.list(RUN_ID)).map((record) => record.name);
    const count = (prefix: string) => names.filter((name) => name.startsWith(prefix)).length;
    expect(count('digest-send:')).toBe(chunks);
    // The fences that must stay per recipient (`fanout-digest.ts` says why).
    expect(count('digest:')).toBe(DIGEST_AUDIENCE);
    expect(count('digest-drain:')).toBe(DIGEST_AUDIENCE);
    expect(report.delivered).toBe(DIGEST_AUDIENCE);
    expect(log.sent.length).toBe(DIGEST_AUDIENCE);
  });
});

describe('unit · one chunk delivers its recipients concurrently, at a bounded width', () => {
  /** Yields to the microtask queue `turns` times: long enough for siblings to start, no timer. */
  const yieldTurns = async (turns: number): Promise<void> => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  };

  /** An individual channel that holds every send open for a while and records the overlap. */
  const overlapping = (fails: ReadonlySet<string> = new Set()) => {
    const seen = { inFlight: 0, max: 0, sent: [] as string[] };
    const channel = deliveryChannel<TestParams>('push', async ({ recipient }) => {
      seen.inFlight += 1;
      seen.max = Math.max(seen.max, seen.inFlight);
      await yieldTurns(200);
      seen.inFlight -= 1;
      if (fails.has(recipient.id)) throw PROVIDER_503;
      seen.sent.push(recipient.id);
    });
    return { seen, channel };
  };

  const handleOver = (channel: ReturnType<typeof overlapping>['channel']) =>
    notifier<TestParams>({
      name: 'post.wide',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `post.wide:${input.postId}`,
      maxRecipients: NOTIFY_CHUNK_SIZE,
      deliver: [{ channel }],
    });

  test('a 500-recipient chunk keeps exactly the width in flight, never more', async () => {
    installNotifyStores({});
    const { seen, channel } = overlapping();
    const report = await driver().finish(handleOver(channel), {
      params,
      recipients: recipients.slice(0, NOTIFY_CHUNK_SIZE),
    });
    expect(NOTIFY_DELIVERY_WIDTH).toBe(16);
    expect(seen.max).toBe(NOTIFY_DELIVERY_WIDTH);
    expect(report.delivered).toBe(NOTIFY_CHUNK_SIZE);
  });

  test('a failing recipient does not stop its neighbours; the step still fails for the retry', async () => {
    installNotifyStores({});
    const { seen, channel } = overlapping(new Set(['r3']));
    const chunk = recipients.slice(0, 40);
    await expect(
      driver().once(handleOver(channel), { params, recipients: chunk }),
    ).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');
    expect([...seen.sent].sort()).toEqual(
      chunk
        .map((recipient) => recipient.id)
        .filter((id) => id !== 'r3')
        .sort(),
    );
  });

  test('a terminal refusal first does not end the job while a retryable neighbour is unsent', async () => {
    installNotifyStores({});
    const channel = deliveryChannel<TestParams>('push', ({ recipient }) => {
      if (recipient.id === 'r1') {
        throw new NotifyPushProviderRefusedError({ provider: 'apns', status: 403, reason: 'x' });
      }
      if (recipient.id === 'r5') throw PROVIDER_503;
    });
    const failure = await driver()
      .once(handleOver(channel), { params, recipients: recipients.slice(0, 8) })
      .catch((error: unknown) => error);
    if (!isUltimateError(failure)) return expect.unreachable('a failing chunk fails its step');
    expect(failure.code).toBe('X_NOTIFY_DELIVERY_FAILED');
    expect(classifyThrown(failure)).not.toBe('terminal');
  });
});
