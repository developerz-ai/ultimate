/**
 * job — what one digest costs. The fan-out's unit is one (org, zone) group, and these assertions
 * are the two reasons it is: a delivery reads its org's post window ONCE however many members
 * read it, and one blipped send re-sends one member. The old per-member delivery re-ran that
 * window query and its own member row once per reader, which is the N+1 pinned here.
 *
 * `sendDigest` installs a queue because it enqueues; the delivery tests deliberately do not, so
 * `send()` falls back to an inline send and the outbox counts deliveries rather than enqueues.
 */

import { expect, test } from 'bun:test';
import { localDateIn } from '@postly/core';
import { type Ctx, createContext } from '@ultimat3/core';
import { applyFlagSnapshot } from '@ultimat3/flags';
import type { JobDriver, StepRunner, StepStore } from '@ultimat3/jobs';
import {
  createMemoryStepStore,
  createMemoryDriver as createQueue,
  createStepRunner,
  jobDriver,
  resetJobDriver,
  setJobDriver,
} from '@ultimat3/jobs';
import type { MailDriver, MailMessage, SendResult, SentMail } from '@ultimat3/mail';
import {
  createMemoryDriver as createOutbox,
  driverUnavailable,
  resetMailDriver,
  setMailDriver,
  tryMailDriver,
} from '@ultimat3/mail';
import { deliverDigest, digestEnabled, sendDigest } from './jobs';

const TINTA = '00000000-0000-4000-8000-00000000e001';
const NUBE = '00000000-0000-4000-8000-00000000e002';
const MADRID = 'Europe/Madrid';
const TOKYO = 'Asia/Tokyo';
const RUN = 'run-digest-1';
/** 09:00 in Madrid on 2026-08-13, and the slot every delivery test is FOR. */
const SLOT_AT = Date.parse('2026-08-13T07:00:00.000Z');
const LOCAL_DATE = '2026-08-13';
/** Never reached: `sends` starts at 1, so no send in the fan-out is the zeroth one. */
const NEVER = 0;

const id = (n: number): string => `00000000-0000-4000-8000-0000000020${String(n).padStart(2, '0')}`;

const member = (n: number, orgId: string, tz: string) => ({
  id: id(n),
  orgId,
  email: `member${n}@postly.example`,
  name: `Member ${n}`,
  role: 'author',
  tz,
  locale: 'en',
  theme: 'system',
  digestOptIn: true,
});

/** Four readers in Madrid, one in Tokyo — one org, two groups, two different windows. */
const TINTA_MEMBERS = [
  member(1, TINTA, MADRID),
  member(2, TINTA, MADRID),
  member(3, TINTA, MADRID),
  member(4, TINTA, MADRID),
  member(5, TINTA, TOKYO),
];

const MADRID_MEMBERS = TINTA_MEMBERS.filter((row) => row.tz === MADRID);

const summary = (slug: string) => ({
  id: `00000000-0000-4000-8000-00000000b0${slug.length}0`,
  orgId: TINTA,
  slug,
  title: `Post ${slug}`,
  excerpt: 'an excerpt',
  coverUrl: null,
  status: 'published',
  likeCount: 0,
  publishedAt: new Date(SLOT_AT - 3_600_000),
  authorId: id(1),
  authorName: 'Ada Lovelace',
});

/** Every read the delivery makes goes through one of these three, so the count IS the statements. */
interface Reads {
  windows: { orgId: string; since: number }[];
  recipients: number;
  orgs: number;
}

const noReads = (): Reads => ({ windows: [], recipients: 0, orgs: 0 });

const contextFor = (reads: Reads, posts: readonly ReturnType<typeof summary>[]): Ctx =>
  createContext({
    role: 'worker',
    services: {
      posts: {
        publishedSince: (orgId: string, since: Date) => {
          reads.windows.push({ orgId, since: since.getTime() });
          return Promise.resolve([...posts]);
        },
      },
      orgs: {
        byId: () => {
          reads.orgs += 1;
          return Promise.resolve({ id: TINTA, slug: 'tinta', name: 'Tinta' });
        },
        digestRecipients: () => {
          reads.recipients += 1;
          return Promise.resolve(TINTA_MEMBERS);
        },
        allDigestRecipients: () =>
          Promise.resolve([...TINTA_MEMBERS, member(6, NUBE, MADRID), member(7, NUBE, TOKYO)]),
      },
    },
  });

/**
 * A transport blip at a chosen position in the fan-out. `mail.failOnce` can only fail the NEXT
 * send, and a failure on the FIRST member cannot tell a per-member step from one step around the
 * whole loop — both re-send from the top. So the failure has to land mid-loop.
 */
interface BlippingMail {
  outbox(): readonly SentMail[];
  restore(): void;
}

const mailFailingOn = (nth: number): BlippingMail => {
  const memory = createOutbox();
  const previous = tryMailDriver();
  let sends = 0;
  const driver: MailDriver = {
    name: 'test',
    send(message: MailMessage): Promise<SendResult> {
      sends += 1;
      if (sends === nth)
        return Promise.reject(driverUnavailable('the provider blipped on purpose'));
      return memory.send(message);
    },
  };
  setMailDriver(driver);
  return {
    outbox: () => memory.outbox(),
    restore: () => {
      if (previous === undefined) resetMailDriver();
      else setMailDriver(previous);
    },
  };
};

const runnerOn = (store: StepStore, jobName: string): StepRunner =>
  createStepRunner({ runId: RUN, jobName, store });

/** One attempt, over a store shared with the attempts before it — which is what makes it a replay. */
const deliver = (runner: StepRunner, reads: Reads, posts: readonly ReturnType<typeof summary>[]) =>
  deliverDigest.run({
    input: { orgId: TINTA, zone: MADRID, localDate: LOCAL_DATE, slotAt: SLOT_AT },
    step: runner.step,
    ctx: contextFor(reads, posts),
    attempt: 1,
    jobId: 'job-digest-1',
    runId: RUN,
  });

test('one window read and one member read, however many readers the group holds', async () => {
  const reads = noReads();
  const mail = mailFailingOn(NEVER);
  const runner = runnerOn(createMemoryStepStore(), 'deliverDigest');

  try {
    expect(await deliver(runner, reads, [summary('raii'), summary('batching')])).toEqual({
      sent: MADRID_MEMBERS.length,
    });
  } finally {
    mail.restore();
  }

  // Four readers, three statements. The old per-member delivery cost eight for the same mail.
  expect(reads.windows).toEqual([{ orgId: TINTA, since: SLOT_AT - 86_400_000 }]);
  expect(reads.recipients).toBe(1);
  expect(reads.orgs).toBe(1);

  expect(runner.usedNames()).toEqual([
    'load-posts',
    'load-org',
    'load-recipients',
    ...MADRID_MEMBERS.map((row) => `send:${row.id}`),
  ]);
  // The Tokyo member shares the org and not the window: a different group mails them.
  expect(mail.outbox().map((sent) => sent.message.to[0])).toEqual(
    [...MADRID_MEMBERS].reverse().map((row) => row.email),
  );
});

test('a blip on the third member re-sends the third, not the first two', async () => {
  const store = createMemoryStepStore();
  const reads = noReads();
  const mail = mailFailingOn(3);
  const posts = [summary('raii')];

  try {
    await expect(deliver(runnerOn(store, 'deliverDigest'), reads, posts)).rejects.toBeUltimateError(
      'X_MAIL_DRIVER_UNAVAILABLE',
    );
    expect(mail.outbox()).toHaveLength(2); // 1 and 2 got theirs before the blip

    const retry = runnerOn(store, 'deliverDigest');
    await deliver(retry, reads, posts);

    expect(retry.replayedNames()).toEqual([
      'load-posts',
      'load-org',
      'load-recipients',
      `send:${id(1)}`,
      `send:${id(2)}`,
    ]);
    expect(mail.outbox()).toHaveLength(MADRID_MEMBERS.length);
    // The three reads above the loop are replayed with it, so the blip costs no statements.
    expect(reads.windows).toHaveLength(1);
    expect(reads.recipients).toBe(1);
    expect(reads.orgs).toBe(1);
  } finally {
    mail.restore();
  }
});

test('an empty window costs one statement and mails nobody', async () => {
  const reads = noReads();
  const mail = mailFailingOn(NEVER);
  const runner = runnerOn(createMemoryStepStore(), 'deliverDigest');

  try {
    expect(await deliver(runner, reads, [])).toEqual({ sent: 0 });
  } finally {
    mail.restore();
  }

  expect(runner.usedNames()).toEqual(['load-posts']);
  expect(reads).toEqual({
    windows: [{ orgId: TINTA, since: SLOT_AT - 86_400_000 }],
    recipients: 0,
    orgs: 0,
  });
  expect(mail.outbox()).toHaveLength(0);
});

test('the ops kill switch stops the fan-out from scheduling anything', async () => {
  const queue: JobDriver = createQueue();
  const previous = jobDriver();
  setJobDriver(queue);
  const runner = runnerOn(createMemoryStepStore(), 'sendDigest');

  applyFlagSnapshot({ [digestEnabled.key]: { default: false } });
  try {
    expect(
      await sendDigest.run({
        input: { runDate: '2026-08-12' },
        step: runner.step,
        ctx: contextFor(noReads(), []),
        attempt: 1,
        jobId: 'job-fanout-off',
        runId: RUN,
      }),
    ).toEqual({ runDate: '2026-08-12', groups: 0 });

    // Off means no recipient read either: the switch is checked before any step runs.
    expect(runner.usedNames()).toEqual([]);
    expect(await queue.introspect?.list({ name: 'deliverDigest', limit: 50 })).toHaveLength(0);
  } finally {
    applyFlagSnapshot({ [digestEnabled.key]: { default: true } });
    if (previous === undefined) resetJobDriver();
    else setJobDriver(previous);
  }
});

test('the idempotency key is the group, so two zones in one org are two digests', () => {
  const slot = { orgId: TINTA, localDate: LOCAL_DATE, slotAt: SLOT_AT } as const;

  expect(deliverDigest.idempotencyKeyFor({ ...slot, zone: MADRID })).toBe(
    `digest:${TINTA}:${MADRID}:${LOCAL_DATE}`,
  );
  expect(deliverDigest.idempotencyKeyFor({ ...slot, zone: TOKYO })).not.toBe(
    deliverDigest.idempotencyKeyFor({ ...slot, zone: MADRID }),
  );
});

test('the fan-out enqueues one delivery per (org, zone), each in its own step', async () => {
  const queue: JobDriver = createQueue();
  const previous = jobDriver();
  setJobDriver(queue);
  const runner = runnerOn(createMemoryStepStore(), 'sendDigest');

  try {
    expect(
      await sendDigest.run({
        input: { runDate: '2026-08-12' },
        step: runner.step,
        ctx: contextFor(noReads(), []),
        attempt: 1,
        jobId: 'job-fanout-1',
        runId: RUN,
      }),
    ).toEqual({ runDate: '2026-08-12', groups: 4 });

    // Seven members, four groups, four enqueues — the fan-out is bounded by groups, not readers.
    expect(runner.usedNames()).toEqual([
      'load-recipients',
      `schedule:${TINTA}:${MADRID}`,
      `schedule:${TINTA}:${TOKYO}`,
      `schedule:${NUBE}:${MADRID}`,
      `schedule:${NUBE}:${TOKYO}`,
    ]);

    const queued = await queue.introspect?.list({ name: 'deliverDigest', limit: 50 });
    expect(queued).toHaveLength(4);
    for (const record of queued ?? []) {
      const input = record.input as { zone: string; slotAt: number; localDate: string };
      // `runAt` is when the queue may release it, `slotAt` is which digest it is — same instant
      // on the way out, and only the first of them moves when the delivery retries.
      expect(record.runAt).toBe(input.slotAt);
      expect(input.localDate).toBe(localDateIn(new Date(input.slotAt), input.zone));
    }
  } finally {
    if (previous === undefined) resetJobDriver();
    else setJobDriver(previous);
  }
});
