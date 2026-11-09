// What the queue tells the instrumentation bus and the trace store: a `job.enqueue` producer span
// and event per enqueued job, a `job.perform` consumer span and event per attempt, both carrying
// OpenTelemetry's stable messaging names — and the run's span a child of the enqueue's.

import { afterEach, describe, expect, test } from 'bun:test';
import type { JobEnqueueEvent, JobPerformEvent, ReadableSpan } from '@ultimat3/core';
import {
  ctxOf,
  resetInstrumentation,
  resetTelemetry,
  SEMCONV,
  SEMCONV_VALUES,
  subscribe,
  withSpan,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { jobWorker } from './worker';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

afterEach(() => {
  resetJobs();
  resetJobDriver();
  resetJobsFacade();
  resetTelemetry();
  resetInstrumentation();
});

const spansOf = (): ReadableSpan[] => {
  const spans: ReadableSpan[] = [];
  subscribe('span.end', (event) => spans.push(event.payload));
  return spans;
};

const declare = (run: () => Promise<void> = () => Promise.resolve()) =>
  job({
    tenant: 'none',
    name: 'chargeCard',
    queue: 'billing',
    input: passthrough<{ orderId: string }>(),
    idempotencyKey: (input) => `order:${input.orderId}`,
    retry: { attempts: 2 },
    run,
  });

const runOnce = async (driver: ReturnType<typeof memoryJobDriver>) => {
  const worker = jobWorker({
    driver,
    queues: ['billing'],
    context: () => ctxOf({ role: 'worker' }),
    drainOnShutdown: false,
  });
  await worker.tick();
  await worker.stop('test');
};

describe('job.enqueue', () => {
  test('emits one event per job with its name, queue and id', async () => {
    installJobDriver(memoryJobDriver());
    const seen: JobEnqueueEvent[] = [];
    subscribe('job.enqueue', (event) => seen.push(event.payload));
    const chargeCard = declare();

    const result = await chargeCard.enqueue({ orderId: 'o-1' });
    await chargeCard.enqueueMany([{ orderId: 'o-2' }, { orderId: 'o-3' }]);

    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ job: 'chargeCard', queue: 'billing', id: result.id });
  });

  test('opens a producer span with the stable messaging attributes', async () => {
    installJobDriver(memoryJobDriver());
    const spans = spansOf();
    const result = await declare().enqueue({ orderId: 'o-1' });

    const producer = spans.find((span) => span.kind === 'producer');
    expect(producer?.name).toBe('job.chargeCard.enqueue');
    expect(producer?.attributes[SEMCONV.messagingSystem]).toBe(
      SEMCONV_VALUES.messagingSystemUltimate,
    );
    // semconv's `send`: one message handed to the queue (`create` is a batch-built message).
    expect(producer?.attributes[SEMCONV.messagingOperationType]).toBe('send');
    expect(producer?.attributes[SEMCONV.messagingDestinationName]).toBe('billing');
    expect(producer?.attributes[SEMCONV.messagingMessageId]).toBe(result.id);
  });
});

describe('job.perform', () => {
  test('emits once per attempt with the attempt number and a duration', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    const seen: JobPerformEvent[] = [];
    subscribe('job.perform', (event) => seen.push(event.payload));
    const { id } = await declare().enqueue({ orderId: 'o-1' });

    await runOnce(driver);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.job).toBe('chargeCard');
    expect(seen[0]?.queue).toBe('billing');
    expect(seen[0]?.id).toBe(id);
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen[0]?.error).toBeUndefined();
  });

  test('a failed attempt is still an attempt, and carries its error', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    const seen: JobPerformEvent[] = [];
    subscribe('job.perform', (event) => seen.push(event.payload));
    await declare(() => Promise.reject(new TypeError('card declined'))).enqueue({ orderId: 'o-1' });

    await runOnce(driver);

    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.error)).toContain('card declined');
  });

  test('the consumer span is a child of the producer span, with the messaging attributes', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    const spans = spansOf();
    let requestTraceId = '';
    await withSpan('action.checkout', async (span) => {
      requestTraceId = span.context.traceId;
      await declare().enqueue({ orderId: 'o-1' });
    });

    await runOnce(driver);

    const producer = spans.find((span) => span.kind === 'producer');
    const consumer = spans.find((span) => span.name === 'job.chargeCard');
    expect(consumer?.kind).toBe('consumer');
    expect(consumer?.context.traceId).toBe(requestTraceId);
    expect(consumer?.parentSpanId).toBe(producer?.context.spanId);
    expect(consumer?.attributes[SEMCONV.messagingOperationType]).toBe(
      SEMCONV_VALUES.messagingOperationProcess,
    );
    expect(consumer?.attributes[SEMCONV.messagingDestinationName]).toBe('billing');
    expect(consumer?.attributes['ultimate.job.attempt']).toBe(1);
    for (const legacy of ['job.name', 'job.id', 'job.attempt']) {
      expect(consumer?.attributes[legacy]).toBeUndefined();
    }
  });
});
