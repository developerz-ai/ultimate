// A prompt answered from ANOTHER process while the browser stays open: `eventPrompt()` is a
// `PromptHandler` that polls the stored job event bus, and `answerPrompt()` is the one way an
// answer is published to it.
//
// It polls IN PROCESS and never uses `step.waitForEvent`: that suspends the run, the attempt ends,
// `runScrape`'s `finally` closes the session — and the site is waiting for the code inside that
// session. So the run keeps its claim (the worker's heartbeat is a timer, untouched by a poll),
// keeps the browser alive between polls, and gives up on the run's own cancellation.
//
// The event name is DERIVED — `scrape-prompt:<runId>:<n>` — and it is not an authorization: the
// app's answering action is policy-checked like any action and calls `answerPrompt()`.

import type { SealKeySource } from '@ultimat3/core';
import { finiteCount, isLocal, isSealed, openText, seal } from '@ultimat3/core';
import type { EventBus, JobEvent } from '@ultimat3/jobs';
import { DriverUnavailableError, eventBus } from '@ultimat3/jobs';
import type { PromptHandler, PromptRequest } from './auth';
import { deadline, throwIfAborted } from './clock';
import { promptAnswerInvalid, promptTimedOut } from './error-throws-session';

/** How often the bus is asked. One indexed read and one browser round trip per interval. */
export const DEFAULT_PROMPT_POLL_MS = 1_000;

/**
 * How long a published answer stays matchable. Short on purpose: an answer is a one-time code,
 * and the stored bus's own default keeps an event for a week.
 */
export const DEFAULT_PROMPT_ANSWER_TTL_MS = 600_000;

/** The one spelling. `index` is `PromptRequest.index`: 1 for the first prompt of an attempt. */
export const promptEventName = (runId: string, index: number): string =>
  `scrape-prompt:${runId}:${String(index)}`;

export interface EventPromptOptions {
  /** Milliseconds one prompt waits for its answer before `X_SCRAPE_PROMPT_UNANSWERED`. */
  readonly timeout: number;
  /** Milliseconds between two looks at the bus. Defaults to `DEFAULT_PROMPT_POLL_MS`. */
  readonly pollMs?: number | undefined;
  /**
   * The bus to read. Defaults to the ambient one, read when the prompt is ASKED — boot installs
   * the stored bus after this module is evaluated. It has to be the stored one in any deployment
   * with more than one process: the answer is published by a web process, never by this worker.
   */
  readonly bus?: EventBus | undefined;
  /** Where the master key is read from, for opening the answer. `seal()`'s own two fields. */
  readonly keySource?: SealKeySource | undefined;
  /** Where the environment is read from. Defaults to the process's own. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * `prompt: eventPrompt({ timeout: 300_000 })` on a `scrape()` definition.
 *
 * Only an answer published AFTER the prompt was asked is consumed. The run id is the same on
 * every attempt, so a code left over from attempt 1 would otherwise be typed into the site by
 * attempt 2 — and a stale code is a refused login. "After" is decided on ONE clock, the bus's
 * (`bus.now()`); the timeout and the poll stay on the run's own.
 */
export function eventPrompt(options: EventPromptOptions): PromptHandler {
  // Floors of 1, both: a zero timeout is a prompt that can never be answered and a zero interval
  // is the poll loop spinning on the worker's only thread.
  const timeoutMs = finiteCount('eventPrompt', 'timeout', options.timeout, 1);
  const pollMs = finiteCount('eventPrompt', 'pollMs', options.pollMs ?? DEFAULT_PROMPT_POLL_MS, 1);
  return async (request: PromptRequest): Promise<string> => {
    const bus = options.bus ?? eventBus();
    // Refused when the prompt is ASKED, before the wait: the answer is published by a web process
    // and read by this worker, so an in-memory bus can only ever time out — minutes later, as
    // `X_SCRAPE_PROMPT_UNANSWERED`, blaming the human who did answer. Development and test run
    // every role in one process, where the in-memory bus is the right one. `=== false`, never
    // `!bus.stored`: only a bus that SAYS it is not stored is refused.
    if (bus.stored === false && !isLocal({ env: options.env, fallback: 'production' })) {
      throw new DriverUnavailableError({
        driver: 'event bus',
        cause:
          'eventPrompt() was asked on the in-memory event bus — the answer is published by another process and can never reach this one',
        fix: 'call setEventBus(createPgEventBus({ executor })) at boot — x dev and the served roles do — or pass bus: createPgEventBus({ executor }) to eventPrompt()',
      });
    }
    const event = promptEventName(request.runId, request.index);
    // The BUS's clock, read once: an answer's `publishedAt` is stamped by it — the database, for
    // the stored bus — and `request.clock` is this worker's. Comparing the two let a few seconds
    // of skew between pods decide that an answer given after the ask had come before it.
    const askedAt = await bus.now();
    const budget = deadline(request.clock, timeoutMs, 'eventPrompt');
    for (;;) {
      if (request.signal !== undefined) throwIfAborted(request.signal);
      const found = await bus.find(event, undefined, askedAt);
      if (found !== undefined) {
        if (!isSealed(found.payload)) {
          throw promptAnswerInvalid({ scrape: request.scrape, label: request.label, event });
        }
        // The purpose IS the event name, so an answer sealed for another run or another prompt of
        // this one fails its tag instead of being typed.
        return await openText(found.payload, { purpose: event, ...options.keySource });
      }
      if (budget.expired()) {
        throw promptTimedOut({
          scrape: request.scrape,
          label: request.label,
          event,
          waitedMs: timeoutMs,
        });
      }
      await request.keepAlive();
      await request.clock.sleep(Math.min(pollMs, budget.remainingMs()), request.signal);
    }
  };
}

export interface AnswerPromptInput {
  readonly runId: string;
  /** Which prompt of the run: `PromptRequest.index`. */
  readonly index: number;
  readonly answer: string;
  /** Milliseconds the answer stays matchable. Defaults to `DEFAULT_PROMPT_ANSWER_TTL_MS`. */
  readonly ttl?: number | undefined;
  readonly bus?: EventBus | undefined;
  readonly keySource?: SealKeySource | undefined;
}

/**
 * Publish one prompt's answer. Called from the app's own action, after its policy passed.
 *
 * The answer is SEALED before it is published: the stored bus is a table, and an OTP or a
 * security answer written there in the clear is a credential in a queue row.
 */
export async function answerPrompt(input: AnswerPromptInput): Promise<JobEvent> {
  const event = promptEventName(input.runId, input.index);
  const sealed = await seal(input.answer, { purpose: event, ...input.keySource });
  return (input.bus ?? eventBus()).publish(event, sealed, {
    ttl: finiteCount('answerPrompt', 'ttl', input.ttl ?? DEFAULT_PROMPT_ANSWER_TTL_MS, 1),
  });
}
