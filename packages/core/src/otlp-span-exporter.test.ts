import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { OTLP_ENDPOINT_KEY } from './otlp';
import { otlpSpanExporter, otlpTraceRequest } from './otlp-span-exporter';
import type { AttributeValue, ReadableSpan } from './telemetry';

const RESOURCE = { serviceName: 'web', serviceVersion: '1.2.0' };

const span = (overrides: Partial<ReadableSpan> = {}): ReadableSpan => ({
  name: 'GET /posts/:id',
  kind: 'server',
  context: {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: 1,
  },
  parentSpanId: undefined,
  startedAt: 1_767_225_600_000,
  endedAt: 1_767_225_600_120,
  durationMs: 120,
  attributes: { 'http.route': '/posts/:id', 'http.status_code': 200 },
  events: [],
  status: { code: 'ok' },
  links: [],
  resource: RESOURCE,
  ...overrides,
});

interface Capture {
  readonly calls: { url: string; body: string; headers: Record<string, string> }[];
  readonly fetch: typeof globalThis.fetch;
}

const capture = (ok = true): Capture => {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return Promise.resolve(new Response('', { status: ok ? 200 : 500 }));
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

const ENV = { endpoint: 'http://collector:4318/v1/traces' };

describe('otlpSpanExporter', () => {
  test('refuses to exist with no endpoint, rather than exporting into nothing', () => {
    const previous = process.env[OTLP_ENDPOINT_KEY];
    delete process.env[OTLP_ENDPOINT_KEY];
    try {
      let code = 'no-throw';
      try {
        otlpSpanExporter();
      } catch (thrown) {
        code = isUltimateError(thrown) ? thrown.code : 'not-ultimate';
      }
      expect(code).toBe('X_OTLP_ENDPOINT_INVALID');
    } finally {
      if (previous !== undefined) process.env[OTLP_ENDPOINT_KEY] = previous;
    }
  });

  test('holds spans until flush — one POST per batch, not one per span', async () => {
    const sink = capture();
    const exporter = otlpSpanExporter({ ...ENV, fetch: sink.fetch });
    exporter.export(span());
    exporter.export(span({ name: 'db.query', kind: 'client' }));
    expect(sink.calls).toHaveLength(0);

    await exporter.flush();
    expect(sink.calls).toHaveLength(1);
    const sent = JSON.parse(sink.calls[0]?.body ?? '{}') as {
      resourceSpans: { scopeSpans: { spans: { name: string; kind: number }[] }[] }[];
    };
    const spans = sent.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map((one) => one.name)).toEqual(['GET /posts/:id', 'db.query']);
    expect(spans.map((one) => one.kind)).toEqual([2, 3]);
    await exporter.shutdown();
  });

  test('POSTs at the batch ceiling without waiting for the timer', async () => {
    const sink = capture();
    const exporter = otlpSpanExporter({ ...ENV, maxBatchSize: 2, fetch: sink.fetch });
    exporter.export(span());
    exporter.export(span());
    await exporter.flush();
    expect(sink.calls).toHaveLength(1);
    await exporter.shutdown();
  });

  test('drops the OLDEST past the queue bound, so an incident keeps the newest spans', async () => {
    const sink = capture();
    const exporter = otlpSpanExporter({
      ...ENV,
      maxQueueSize: 2,
      maxBatchSize: 1000,
      fetch: sink.fetch,
    });
    exporter.export(span({ name: 'oldest' }));
    exporter.export(span({ name: 'middle' }));
    exporter.export(span({ name: 'newest' }));
    await exporter.flush();
    const sent = JSON.parse(sink.calls[0]?.body ?? '{}') as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    expect((sent.resourceSpans[0]?.scopeSpans[0]?.spans ?? []).map((one) => one.name)).toEqual([
      'middle',
      'newest',
    ]);
    await exporter.shutdown();
  });

  /**
   * `AttributeValue` is a compile-time claim and the exporter is handed whatever an app put on a
   * span, so `anyValue`'s fallthrough (`value.map(...)`) throws SYNCHRONOUSLY for a value it cannot
   * spell. That throw was the one thing that could reject `inflight`, and the chain carried the
   * rejection forever: `post` was never called again while the queue kept emptying — every later
   * span dropped in silence — and each interval tick minted a fresh unhandled rejection, which Bun
   * ends the process on. Telemetry is best-effort; it must never be the exit code.
   */
  test('a batch that cannot be serialised is dropped, and the next one still exports', async () => {
    const sink = capture();
    const exporter = otlpSpanExporter({ ...ENV, fetch: sink.fetch });
    const unspellable = { nested: 'not an AttributeValue' } as unknown as AttributeValue;
    exporter.export(span({ attributes: { bad: unspellable } }));

    // Rejected before the fix — and this is the `void drainQueue()` the timer runs, so the
    // rejection had nobody to reach but the process.
    await exporter.flush();

    expect(sink.calls).toHaveLength(0);
    exporter.export(span({ name: 'after' }));
    await exporter.flush();
    const sent = JSON.parse(sink.calls[0]?.body ?? '{}') as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    expect((sent.resourceSpans[0]?.scopeSpans[0]?.spans ?? []).map((one) => one.name)).toEqual([
      'after',
    ]);
    await exporter.shutdown();
  });

  test('a collector that is down never reaches the caller', async () => {
    const exporter = otlpSpanExporter({
      ...ENV,
      fetch: (() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch,
    });
    exporter.export(span());
    await exporter.flush();
    await exporter.shutdown();
  });
});

describe('otlpTraceRequest', () => {
  test('is the OTLP/JSON shape a collector accepts, hex ids and nanosecond strings', () => {
    const request = otlpTraceRequest(
      [
        span({
          parentSpanId: '00f067aa0ba902b7',
          events: [{ name: 'exception', at: 1_767_225_600_050, attributes: { 'error.code': 'X' } }],
          status: { code: 'error', message: 'boom' },
        }),
      ],
      RESOURCE,
    );
    expect(request).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'web' } },
              { key: 'service.version', value: { stringValue: '1.2.0' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: '@ultimat3/core' },
              spans: [
                {
                  traceId: '0af7651916cd43dd8448eb211c80319c',
                  spanId: 'b7ad6b7169203331',
                  parentSpanId: '00f067aa0ba902b7',
                  name: 'GET /posts/:id',
                  kind: 2,
                  startTimeUnixNano: '1767225600000000000',
                  endTimeUnixNano: '1767225600120000000',
                  attributes: [
                    { key: 'http.route', value: { stringValue: '/posts/:id' } },
                    { key: 'http.status_code', value: { intValue: '200' } },
                  ],
                  events: [
                    {
                      timeUnixNano: '1767225600050000000',
                      name: 'exception',
                      attributes: [{ key: 'error.code', value: { stringValue: 'X' } }],
                    },
                  ],
                  links: [],
                  status: { code: 2, message: 'boom' },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test('omits parentSpanId for a root span rather than sending an empty one', () => {
    const request = otlpTraceRequest([span()], RESOURCE) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    expect(request.resourceSpans[0]?.scopeSpans[0]?.spans[0]).not.toHaveProperty('parentSpanId');
  });
});
