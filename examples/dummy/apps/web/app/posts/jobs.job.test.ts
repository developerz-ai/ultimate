/**
 * job — the retry unit of a fan-out. `notifySubscribers` mails everyone in the org who opted in,
 * and the guarantee asserted here is that one transport failure costs one re-send: the step is per
 * recipient, so a blip on the third of four replays the first two from storage instead of mailing
 * the whole org a second time.
 *
 * No queue is installed on purpose — `send()` falls back to an inline send when no job driver is
 * configured, which is what lets the outbox below count deliveries rather than enqueues.
 */

import { expect, test } from 'bun:test';
import { type Ctx, createContext } from '@ultimat3/core';
import type { StepRunner, StepStore } from '@ultimat3/jobs';
import { createMemoryStepStore, createStepRunner } from '@ultimat3/jobs';
import type { MailDriver, MailMessage, SendResult, SentMail } from '@ultimat3/mail';
import {
  createMemoryDriver,
  driverUnavailable,
  resetMailDriver,
  setMailDriver,
  tryMailDriver,
} from '@ultimat3/mail';
import { notifySubscribers } from './jobs';

const ORG = '00000000-0000-4000-8000-00000000f001';
const POST = '00000000-0000-4000-8000-00000000f0a1';
const RUN = 'run-notify-1';
const RECIPIENTS = 4;
/** Never reached: `sends` starts at 1, so no send in the fan-out is the zeroth one. */
const NEVER = 0;

const id = (n: number): string => `00000000-0000-4000-8000-0000000010${String(n).padStart(2, '0')}`;

const member = (n: number) => ({
  id: id(n),
  orgId: ORG,
  email: `member${n}@tinta.example`,
  name: `Member ${n}`,
  role: 'author',
  tz: 'Europe/Madrid',
  locale: 'en',
  theme: 'system',
  digestOptIn: true,
});

const post = {
  id: POST,
  orgId: ORG,
  slug: 'raii',
  title: 'Handles that close themselves',
  excerpt: 'an excerpt',
  body: 'a body',
  coverUrl: null,
  status: 'published',
  likeCount: 0,
  publishedAt: new Date('2026-08-12T09:00:00.000Z'),
  authorId: id(1),
  authorName: 'Ada Lovelace',
};

/** How many statements the run cost. Every read the job makes goes through one of these three. */
interface Reads {
  posts: number;
  recipients: number;
  orgs: number;
}

const noReads = (): Reads => ({ posts: 0, recipients: 0, orgs: 0 });

/** The three services the job reads, and nothing else: a stub that answered more would hide a read. */
const contextFor = (reads: Reads): Ctx =>
  createContext({
    role: 'worker',
    services: {
      posts: {
        byId: () => {
          reads.posts += 1;
          return Promise.resolve(post);
        },
      },
      orgs: {
        byId: () => {
          reads.orgs += 1;
          return Promise.resolve({ id: ORG, slug: 'tinta', name: 'Tinta' });
        },
        digestRecipients: () => {
          reads.recipients += 1;
          return Promise.resolve(Array.from({ length: RECIPIENTS }, (_, n) => member(n + 1)));
        },
      },
      channel: () => ({ publish: () => Promise.resolve() }),
    },
  });

/**
 * A transport blip at a chosen position in the fan-out. `mail.failOnce` can only fail the NEXT
 * send, and a failure on the FIRST recipient cannot tell a per-recipient step from one step around
 * the whole loop — both re-send from the top. So the failure has to land mid-loop.
 */
interface BlippingMail {
  outbox(): readonly SentMail[];
  restore(): void;
}

const mailFailingOn = (nth: number): BlippingMail => {
  const memory = createMemoryDriver();
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

const runnerOn = (store: StepStore): StepRunner =>
  createStepRunner({ runId: RUN, jobName: 'notifySubscribers', store });

/** One attempt, over a store shared with the attempts before it — which is what makes it a replay. */
const attempt = (runner: StepRunner, reads: Reads, nth: number): Promise<unknown> =>
  notifySubscribers.run({
    input: { postId: POST },
    step: runner.step,
    ctx: contextFor(reads),
    attempt: nth,
    jobId: 'job-notify-1',
    runId: RUN,
  });

test('the send loop is one step per recipient, named for the recipient', async () => {
  const mail = mailFailingOn(NEVER);
  const runner = runnerOn(createMemoryStepStore());

  try {
    await attempt(runner, noReads(), 1);
  } finally {
    mail.restore();
  }

  expect(runner.usedNames()).toEqual([
    'load-post',
    'announce',
    'load-recipients',
    'load-org',
    `send:${id(1)}`,
    `send:${id(2)}`,
    `send:${id(3)}`,
    `send:${id(4)}`,
  ]);
  expect(mail.outbox()).toHaveLength(RECIPIENTS);
});

test('a blip on the third recipient re-sends the third, not the first two', async () => {
  const store = createMemoryStepStore();
  const reads = noReads();
  const mail = mailFailingOn(3);

  try {
    await expect(attempt(runnerOn(store), reads, 1)).rejects.toBeUltimateError(
      'X_MAIL_DRIVER_UNAVAILABLE',
    );
    expect(mail.outbox()).toHaveLength(2); // 1 and 2 got theirs before the blip

    const retry = runnerOn(store);
    await attempt(retry, reads, 2);

    // Everything the first attempt completed is served from storage, so the retry sends only the
    // two recipients it never reached: four mails in total, not six.
    expect(retry.replayedNames()).toEqual([
      'load-post',
      'announce',
      'load-recipients',
      'load-org',
      `send:${id(1)}`,
      `send:${id(2)}`,
    ]);
    expect(mail.outbox()).toHaveLength(RECIPIENTS);
    // And the loads above the loop are replayed with it, so the blip costs no statements.
    expect(reads).toEqual({ posts: 1, recipients: 1, orgs: 1 });
  } finally {
    mail.restore();
  }
});
