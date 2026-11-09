// What the queue reports while it works: the `job.enqueue` producer span and event around every
// enqueue, and the stable messaging attributes both the producer and the consumer span carry. One
// file so `job.ts` (the enqueue door) and `worker-run.ts` (the run) spell the semconv names once.

import type { SpanAttributes } from '@ultimat3/core';
import { instrument, SEMCONV, SEMCONV_VALUES, subscribed, withSpan } from '@ultimat3/core';
import type { EnqueueRequest, EnqueueResult } from './driver';
import { ambientTraceparent } from './enqueue-record';

/** The attributes every job span carries, producer and consumer alike. */
export function messagingAttributes(
  operation: 'send' | 'process',
  queue: string,
  job: string,
): SpanAttributes {
  return {
    [SEMCONV.messagingSystem]: SEMCONV_VALUES.messagingSystemUltimate,
    [SEMCONV.messagingOperationType]:
      operation === 'send'
        ? SEMCONV_VALUES.messagingOperationSend
        : SEMCONV_VALUES.messagingOperationProcess,
    [SEMCONV.messagingOperationName]: operation === 'send' ? 'enqueue' : 'perform',
    [SEMCONV.messagingDestinationName]: queue,
    'ultimate.job.name': job,
  };
}

/**
 * Run an enqueue under its producer span and tell the bus about each job it created. The span is
 * open while the row is written, so the `traceparent` the row carries (`ambientTraceparent()`) is
 * THIS span's — the run's consumer span becomes its child, as OpenTelemetry's messaging model
 * says. A deduped enqueue still reports: the caller asked, and the id names the live job.
 */
export async function instrumentedEnqueue<R extends EnqueueResult | readonly EnqueueResult[]>(
  job: string,
  queue: string,
  enqueue: () => Promise<R>,
): Promise<R> {
  const results = await withSpan(
    `job.${job}.enqueue`,
    async (span) => {
      const answered = await enqueue();
      const list = listOf(answered);
      const [only] = list;
      if (list.length === 1 && only !== undefined) {
        span.setAttribute(SEMCONV.messagingMessageId, only.id);
      } else {
        span.setAttribute('ultimate.job.count', list.length);
      }
      return answered;
    },
    { kind: 'producer', attributes: messagingAttributes('send', queue, job) },
  );
  if (subscribed('job.enqueue')) {
    for (const { id } of listOf(results)) {
      instrument('job.enqueue', { job, queue, id });
    }
  }
  return results;
}

/**
 * A scheduler fire — one task's jobs and its watermark in ONE store write, so no per-job span can
 * wrap it — under one producer span named for the TASK. Each request is stamped with that span's
 * `traceparent` before the write, so every run it starts is the span's child; each job the write
 * created is one `job.enqueue`. `undefined` (another dispatcher fired it) reports nothing.
 */
export async function instrumentedFire(
  task: string,
  requests: readonly EnqueueRequest[],
  fire: (stamped: readonly EnqueueRequest[]) => Promise<readonly EnqueueResult[] | undefined>,
): Promise<readonly EnqueueResult[] | undefined> {
  const [first] = requests;
  const oneQueue =
    first !== undefined && requests.every((request) => request.queue === first.queue);
  const results = await withSpan(
    `job.${task}.enqueue`,
    (span) => {
      const trace = ambientTraceparent();
      span.setAttribute('ultimate.job.count', requests.length);
      return fire(
        trace === undefined
          ? requests
          : requests.map((request) => ({ ...request, traceparent: trace })),
      );
    },
    {
      kind: 'producer',
      attributes: {
        [SEMCONV.messagingSystem]: SEMCONV_VALUES.messagingSystemUltimate,
        [SEMCONV.messagingOperationType]: SEMCONV_VALUES.messagingOperationSend,
        [SEMCONV.messagingOperationName]: 'enqueue',
        ...(oneQueue ? { [SEMCONV.messagingDestinationName]: first.queue } : {}),
        'ultimate.task.name': task,
      },
    },
  );
  if (results !== undefined && subscribed('job.enqueue')) {
    requests.forEach((request, index) => {
      const id = results[index]?.id;
      if (id !== undefined && id !== '') {
        instrument('job.enqueue', { job: request.name, queue: request.queue, id });
      }
    });
  }
  return results;
}

/** One enqueue's answer or many, as a list — a function, so a generic `R` narrows through it. */
const listOf = (value: EnqueueResult | readonly EnqueueResult[]): readonly EnqueueResult[] =>
  isList(value) ? value : [value];

const isList = (
  value: EnqueueResult | readonly EnqueueResult[],
): value is readonly EnqueueResult[] => Array.isArray(value);
