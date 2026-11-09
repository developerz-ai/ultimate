// J6: nothing survived an enqueue. `docs/idea/04-jobs.md` promised "trace linked to the enqueuing
// request" and there was no field to carry the link — a checkout's `chargeCard` opened a fresh
// root two seconds later with nothing pointing back — and no record of who asked for the work.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  ctxOf,
  resetInstrumentation,
  resetTelemetry,
  subscribe,
  traceparent,
  withSpan,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver, setJobDriver } from './driver';
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

const collectSpans = (): ReadableSpan[] => {
  const spans: ReadableSpan[] = [];
  subscribe('span.end', (event) => spans.push(event.payload));
  return spans;
};

describe('the trace link across the queue', () => {
  // v31: the row carries the enqueue's PRODUCER span, a child of the caller's — OpenTelemetry's
  // messaging shape, so the run hangs off the enqueue and the enqueue off the request.
  test('an enqueue inside a span stamps its producer span, a child of that span, onto the row', async () => {
    const spans = collectSpans();
    const driver = memoryJobDriver();
    setJobDriver(driver);

    const chargeCard = job({
      tenant: 'none',
      name: 'chargeCard',
      input: passthrough<{ orderId: string }>(),
      idempotencyKey: (input) => `order:${input.orderId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    let checkoutSpanId = '';
    await withSpan('action.checkout', async (span) => {
      checkoutSpanId = span.context.spanId;
      await chargeCard.enqueue({ orderId: 'o-1' });
    });

    const producer = spans.find((span) => span.name === 'job.chargeCard.enqueue');
    expect(producer?.parentSpanId).toBe(checkoutSpanId);
    const [row] = (await driver.introspect?.list()) ?? [];
    expect(row?.traceparent).toBe(
      producer === undefined ? 'no producer' : traceparent(producer.context),
    );
  });

  test('the job span is a CHILD of the enqueuing request, not a new root', async () => {
    const spans = collectSpans();
    const driver = memoryJobDriver();
    setJobDriver(driver);

    job({
      tenant: 'none',
      name: 'chargeCard',
      input: passthrough<{ orderId: string }>(),
      idempotencyKey: (input) => `order:${input.orderId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    let requestTraceId = '';
    let requestSpanId = '';
    await withSpan('action.checkout', async (span) => {
      requestTraceId = span.context.traceId;
      requestSpanId = span.context.spanId;
      await driver.enqueue({
        name: 'chargeCard',
        queue: 'default',
        input: { orderId: 'o-1' },
        idempotencyKey: 'order:o-1',
        maxAttempts: 1,
        traceparent: traceparent(span.context),
      });
    });

    const worker = jobWorker({
      driver,
      context: () => ctxOf({ role: 'worker' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    await worker.stop('test');

    const jobSpan = spans.find((span) => span.name === 'job.chargeCard');
    expect(jobSpan?.context.traceId).toBe(requestTraceId);
    expect(jobSpan?.parentSpanId).toBe(requestSpanId);
  });

  // v31: outside any trace the enqueue's producer span is the ROOT, so the row carries that span —
  // never the all-zero span id a context with no span renders, which every collector rejects.
  test('an enqueue outside any trace carries its producer root, never a malformed header', async () => {
    const driver = memoryJobDriver();
    setJobDriver(driver);
    const sendDigest = job({
      tenant: 'none',
      name: 'sendDigest',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'digest',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    // A script, a cron, a test.
    const spans = collectSpans();
    await sendDigest.enqueue({});
    const [row] = (await driver.introspect?.list()) ?? [];
    const producer = spans.find((span) => span.name === 'job.sendDigest.enqueue');
    expect(producer?.parentSpanId).toBeUndefined();
    expect(row?.traceparent).toMatch(/^00-[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/);
    expect(row?.traceparent).toBe(
      producer === undefined ? 'no producer' : traceparent(producer.context),
    );
  });

  test('handle.as(actor) records WHO asked and grants them nothing', async () => {
    const driver = memoryJobDriver();
    setJobDriver(driver);
    const exportLedger = job({
      tenant: 'none',
      name: 'exportLedger',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'export',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    await exportLedger.as({ id: 'user-9', orgId: 'org-1' }, {});

    const [row] = (await driver.introspect?.list()) ?? [];
    // Attribution, never authority: the row says who asked, the body still runs as the system.
    // Impersonating the enqueuer would make a job that sleeps three days act as somebody whose
    // role — or employment — has changed since.
    expect(row?.enqueuedBy).toBe('user-9');
    expect(row?.tenantId).toBe('org-1');
  });
});
