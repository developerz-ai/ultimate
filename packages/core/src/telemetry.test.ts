import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { createContext, runWithContext } from './context';
import {
  configureTelemetry,
  currentSpan,
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
