// J6: nothing survived an enqueue. `docs/idea/04-jobs.md` promised "trace linked to the enqueuing
// request" and there was no field to carry the link — a checkout's `chargeCard` opened a fresh
// root two seconds later with nothing pointing back — and no record of who asked for the work.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  configureTelemetry,
  createContext,
  resetTelemetry,
  traceparent,
  withSpan,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { createWorker } from './worker';

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
});

const collectSpans = (): ReadableSpan[] => {
  const spans: ReadableSpan[] = [];
  configureTelemetry({ exporter: { export: (span) => spans.push(span) } });
  return spans;
};

describe('the trace link across the queue', () => {
  test('an enqueue inside a span stamps that span onto the row', async () => {
    const spans = collectSpans();
    const driver = createMemoryDriver();
    setJobDriver(driver);

    const chargeCard = job({
      tenant: 'none',
      name: 'chargeCard',
      input: passthrough<{ orderId: string }>(),
      idempotencyKey: (input) => `order:${input.orderId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    let expected = '';
    await withSpan('action.checkout', async (span) => {
      expected = traceparent(span.context);
      await chargeCard.enqueue({ orderId: 'o-1' });
    });

    const [row] = (await driver.introspect?.list()) ?? [];
    expect(row?.traceparent).toBe(expected);
    expect(spans.some((span) => span.name === 'action.checkout')).toBe(true);
  });

  test('the job span is a CHILD of the enqueuing request, not a new root', async () => {
    const spans = collectSpans();
    const driver = createMemoryDriver();
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

    const worker = createWorker({
      driver,
      context: () => createContext({ role: 'worker' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    await worker.stop('test');

    const jobSpan = spans.find((span) => span.name === 'job.chargeCard');
    expect(jobSpan?.context.traceId).toBe(requestTraceId);
    expect(jobSpan?.parentSpanId).toBe(requestSpanId);
  });

  test('an enqueue outside any trace carries no header rather than a malformed one', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    const sendDigest = job({
      tenant: 'none',
      name: 'sendDigest',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'digest',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    // A script, a cron, a test. An all-zero span id renders a traceparent every collector rejects.
    await sendDigest.enqueue({});
    const [row] = (await driver.introspect?.list()) ?? [];
    expect(row?.traceparent).toBeUndefined();
  });

  test('handle.as(actor) records WHO asked and grants them nothing', async () => {
    const driver = createMemoryDriver();
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
