import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { createContext, runWithContext } from './context';
import { traceId as newTraceId, spanId, uuid } from './ids';
import { alwaysOffSampler, alwaysOnSampler, parentBasedRatioSampler } from './sampler';
import type { SpanContext } from './telemetry';
import {
  configureTelemetry,
  currentSpan,
  currentSpanContext,
  memoryExporter,
  parseTraceparent,
  resetTelemetry,
  startSpan,
  traceparent,
  withSpan,
  withSpanContext,
} from './telemetry';

afterEach(() => {
  resetTelemetry();
});

describe('telemetry', () => {
  test('is free when unconfigured — the default exporter drops spans', () => {
    const span = startSpan('noop');
    span.setAttribute('a', 1).end();
    expect(span.ended).toBe(true);
  });

  test('nested spans share the trace and record the parent', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter, clock: frozenClock(0) });

    withSpan('outer', (outer) => {
      withSpan('inner', (inner) => {
        expect(currentSpan()?.name).toBe('inner');
        expect(inner.context.traceId).toBe(outer.context.traceId);
      });
    });

    expect(exporter.spans.map((span) => span.name)).toEqual(['inner', 'outer']);
    const [inner, outer] = exporter.spans;
    expect(inner?.parentSpanId).toBe(outer?.context.spanId);
    expect(inner?.context.traceId).toBe(outer?.context.traceId);
  });

  test('adopts the request traceId so HTTP -> job -> live query is one trace', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter });
    const ctx = createContext({});

    runWithContext(ctx, () => {
      withSpan('action.publishPost', () => undefined);
    });

    expect(exporter.spans[0]?.context.traceId).toBe(ctx.traceId);
  });

  test('async spans end on rejection and record the error code', async () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter });

    await expect(
      withSpan('job.onboardOrg', async () => {
        await Bun.sleep(1);
        throw new Error('provision failed');
      }),
    ).rejects.toThrow('provision failed');

    const span = exporter.spans[0];
    expect(span?.status.code).toBe('error');
    expect(span?.events[0]?.name).toBe('exception');
    expect(span?.events[0]?.attributes['error.code']).toBe('X_INTERNAL');
  });

  test('recording a hostile throwable never replaces the caller’s real failure', () => {
    // `error instanceof Error ? error.message : String(error)` is two property reads on a value
    // the framework did not build. `withSpan` wraps `cache.invalidate`, `db.<verb>` and every
    // HTTP and job span, so a throw HERE substitutes the tracer's TypeError for the failure the
    // caller was about to handle — and the span it was meant to annotate is never ended.
    const exporter = memoryExporter();
    configureTelemetry({ exporter });
    const real = new Proxy(new Error('real failure'), {
      getPrototypeOf(): never {
        throw new TypeError('proxy trap');
      },
    });

    let caught: unknown;
    try {
      withSpan('db.update', () => {
        throw real;
      });
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBe(real);
    expect(exporter.spans[0]?.status.code).toBe('error');
    expect(exporter.spans[0]?.events[0]?.name).toBe('exception');
  });

  test('a bigint thrown out of a span is recorded, not rethrown as a TypeError', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter });
    expect(() =>
      withSpan('job.tick', () => {
        throw 10n;
      }),
    ).toThrow();
    expect(exporter.spans[0]?.events[0]?.attributes['error.message']).toBe('10n');
  });

  test('traceparent round-trips for cross-process propagation', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter });
    const outbound = startSpan('http.client');
    const header = traceparent(outbound.context);
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const inbound = parseTraceparent(header);
    expect(inbound?.traceId).toBe(outbound.context.traceId);
    withSpanContext(inbound as NonNullable<typeof inbound>, 'worker.step', () => undefined);
    expect(exporter.spans[0]?.context.traceId).toBe(outbound.context.traceId);
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
  });
});

describe('sampling', () => {
  test("an upstream's 'do not sample' is obeyed, not just forwarded", () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter });
    withSpanContext(
      { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 0 },
      'GET /posts',
      (span) => {
        span.setAttribute('http.route', '/posts');
      },
    );
    expect(exporter.spans).toHaveLength(0);
  });

  test('an unsampled span still propagates the decision downstream', () => {
    configureTelemetry({ sampler: alwaysOffSampler });
    const span = startSpan('root');
    expect(span.context.traceFlags).toBe(0);
    expect(traceparent(span.context).endsWith('-00')).toBe(true);
  });

  test('a configured sampler overrides the env default', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter, sampler: alwaysOffSampler });
    startSpan('dropped').end();
    expect(exporter.spans).toHaveLength(0);

    configureTelemetry({ sampler: alwaysOnSampler });
    startSpan('kept').end();
    expect(exporter.spans.map((span) => span.name)).toEqual(['kept']);
  });

  test('a sampled parent keeps every child in the same trace exported', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter, sampler: alwaysOnSampler });
    withSpan('outer', () => {
      withSpan('inner', () => undefined);
    });
    expect(exporter.spans.map((span) => span.name)).toEqual(['inner', 'outer']);
  });

  test('resetTelemetry drops a configured sampler', () => {
    configureTelemetry({ sampler: alwaysOffSampler });
    resetTelemetry();
    expect(startSpan('root').context.traceFlags).toBe(1);
  });

  /**
   * `currentSpanContext()` answers a request context with a trace id and an EMPTY span id — it is
   * a correlation id this process minted, not an upstream that said "sampled". Reading its
   * `traceFlags` as an inbound decision made `parentBasedRatioSampler` inherit a bit nobody sent,
   * so every HTTP root span was exported at every ratio: `pipeline.ts` is `runWithContext` then
   * `withSpan`, which is this exact pair.
   */
  test('a request context is a trace id, never an upstream sampling decision', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter, sampler: parentBasedRatioSampler(0) });

    runWithContext(createContext({}), () => {
      withSpan('GET /posts', () => undefined);
    });

    expect(exporter.spans).toHaveLength(0);
  });

  test('sampled inside a request context, the root span still has no parent span', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter, sampler: parentBasedRatioSampler(1) });
    const ctx = createContext({});

    runWithContext(ctx, () => {
      withSpan('GET /posts', () => undefined);
    });

    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.parentSpanId).toBeUndefined();
    expect(exporter.spans[0]?.context.traceId).toBe(ctx.traceId);
  });

  test('a real inbound parent is still obeyed, sampled or not', () => {
    const exporter = memoryExporter();
    configureTelemetry({ exporter, sampler: parentBasedRatioSampler(0) });
    const parent = { traceId: newTraceId(), spanId: spanId(), traceFlags: 1 } as const;

    runWithContext(createContext({}), () => {
      withSpan('GET /posts', () => undefined, { parent });
    });

    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.parentSpanId).toBe(parent.spanId);
    expect(exporter.spans[0]?.context.traceId).toBe(parent.traceId);
  });
});

describe('traceparent', () => {
  test('rejects an all-zero id even though the hex shape matches', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-b7ad6b7169203331-01`)).toBeUndefined();
    expect(
      parseTraceparent(`00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`),
    ).toBeUndefined();
  });

  test('rejects a header built from a UUID trace id', () => {
    expect(
      parseTraceparent(traceparent({ traceId: uuid(), spanId: spanId(), traceFlags: 1 })),
    ).toBeUndefined();
  });

  test('round-trips the ids core mints', () => {
    const context = { traceId: newTraceId(), spanId: spanId(), traceFlags: 1 };
    expect(parseTraceparent(traceparent(context))).toEqual(context);
  });

  // The synthetic context a request builds carries `spanId: ''`. Interpolated bare it rendered
  // `00-<trace>--01`, 39 characters, which this file's own regex — and every collector — rejects.
  test('substitutes a span id for the synthetic context a request builds', () => {
    const ctx = createContext({ traceId: newTraceId() });
    const header = runWithContext(ctx, () => traceparent(currentSpanContext() as SpanContext));

    const parsed = parseTraceparent(header);
    expect(parsed).toBeDefined();
    expect(parsed?.traceId).toBe(ctx.traceId);
    expect(parsed?.spanId).not.toBe('');
    expect(header).not.toContain('--');
  });

  test('a fresh span id is minted per call, never a zero one a collector drops', () => {
    const context = { traceId: newTraceId(), spanId: '', traceFlags: 1 };
    const first = parseTraceparent(traceparent(context));
    const second = parseTraceparent(traceparent(context));

    expect(first?.spanId).not.toBe('0'.repeat(16));
    expect(first?.spanId).not.toBe(second?.spanId);
  });
});
