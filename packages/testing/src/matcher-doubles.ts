// Single responsibility: the two assertions on what a test's fixtures CAUGHT — a job on the
// `runJobs` queue (`toHaveEnqueued`) and a mail in the `mail` outbox (`toHaveSentMail`). Each reads
// the fixture it is handed and refuses any other receiver by code, synchronously: under `.not` a
// `pass: false` for a wrong receiver would read as a pass.

import { renderCauseValue } from '@ultimat3/core';
import type { JobRecord } from '@ultimat3/jobs';
import type { MatcherResult } from './matcher-result';
import type { EnqueuedJobRef, MatcherMailRef, SentMailMatch } from './matcher-surface';
import {
  TestExpectedInputInvalidError,
  TestMailExpectedError,
  TestRunJobsExpectedError,
} from './stub-errors';

/** The `mail` fixture's reading half — all `toHaveSentMail` needs. */
interface OutboxLike {
  outbox(): readonly {
    readonly message: { readonly mailId: string; readonly to: readonly string[] };
  }[];
}

/** The `runJobs` fixture's reading half — all `toHaveEnqueued` needs. */
interface QueueLike {
  enqueued(handle: EnqueuedJobRef<unknown>): Promise<readonly JobRecord[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null;

type Parsed =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: unknown };

/** `raw` as `handle`'s body would receive it, or what its schema said instead. */
function parseJobInput(handle: EnqueuedJobRef<unknown>, raw: unknown): Parsed {
  try {
    return { ok: true, value: handle.parse(raw) };
  } catch (error) {
    return { ok: false, issue: error instanceof Error ? error.message : error };
  }
}

/**
 * `await expect(runJobs).toHaveEnqueued(sendWelcome, { userId })` — a row for that job, in any
 * state, whose input equals `input` once both are parsed by the job's own schema. No `input`: any
 * row for the job.
 */
export function toHaveEnqueued(
  received: unknown,
  handle: EnqueuedJobRef<unknown>,
  ...rest: readonly unknown[]
): Promise<MatcherResult> {
  if (!isRecord(received) || typeof received['enqueued'] !== 'function') {
    throw new TestRunJobsExpectedError(received);
  }
  const queue = received as unknown as QueueLike;
  const expected = rest.length === 0 ? undefined : parseJobInput(handle, rest[0]);
  if (expected?.ok === false) {
    throw new TestExpectedInputInvalidError('toHaveEnqueued', handle.name, expected.issue);
  }
  return queue.enqueued(handle).then((rows) => {
    const inputs = rows.map((row) => {
      const stored = parseJobInput(handle, row.input);
      return stored.ok ? stored.value : row.input;
    });
    const pass =
      expected === undefined
        ? rows.length > 0
        : inputs.some((input) => Bun.deepEquals(input, expected.value));
    const what = expected === undefined ? '' : ` with ${renderCauseValue(expected.value)}`;
    return {
      pass,
      message: () =>
        pass
          ? `expected "${handle.name}" not to have been enqueued${what}`
          : `expected "${handle.name}" to have been enqueued${what}; the queue holds ${String(rows.length)}: ${renderCauseValue(inputs)}`,
    };
  });
}

/** `expect(mail).toHaveSentMail(welcomeMail, { to })` — that mail, to that address when named. */
export function toHaveSentMail(
  received: unknown,
  mail: MatcherMailRef,
  match: SentMailMatch = {},
): MatcherResult {
  if (!isRecord(received) || typeof received['outbox'] !== 'function') {
    throw new TestMailExpectedError(received);
  }
  const id = typeof mail === 'string' ? mail : mail.id;
  const sent = (received as unknown as OutboxLike).outbox().map((entry) => entry.message);
  const pass = sent.some(
    (message) => message.mailId === id && (match.to === undefined || message.to.includes(match.to)),
  );
  const to = match.to === undefined ? '' : ` to ${match.to}`;
  return {
    pass,
    message: () =>
      pass
        ? `expected "${id}" not to have been sent${to}`
        : `expected "${id}" to have been sent${to}; the outbox holds ${renderCauseValue(sent.map((message) => ({ mailId: message.mailId, to: message.to })))}`,
  };
}
