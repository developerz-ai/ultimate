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

/**
 * A `fetch` double that really IS a `typeof globalThis.fetch`.
 *
 * Bun's `fetch` is a function with a namespace beside it — `fetch.preconnect` — so a bare arrow no
 * longer satisfies the type, and the three doubles in this file each cast the gap away instead. A
 * cast would keep passing the day the exporter starts calling something the double lacks; this
 * supplies the whole surface, and `preconnect` is a no-op because a test double must never open a
 * socket to the collector it is standing in for.
 */
const stubFetch = (
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => Object.assign(handler, { preconnect: (): void => {} });

interface Capture {
  readonly calls: { url: string; body: string; headers: Record<string, string> }[];
  readonly fetch: typeof globalThis.fetch;
}

const capture = (ok = true): Capture => {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetch = stubFetch((url, init) => {
    calls.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return Promise.resolve(new Response('', { status: ok ? 200 : 500 }));
  });
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
      // The collector's own refusal, handed to the subject — this test's input, never its verdict.
      fetch: stubFetch(() => Promise.reject(new Error('ECONNREFUSED'))),
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

/**
 * A bound whose value is not a number turns its own comparison off, and one of these is a TIMER:
 * measured in this Bun, `setInterval(fn, NaN)` warns `TimeoutNaNWarning` and runs at **1ms**, so a
 * `flushIntervalMs` of `Number(process.env.OTEL_FLUSH_MS)` on an unset variable POSTs to the
 * collector a thousand times a second. `timeoutMs` is the other direction:
 * `AbortSignal.timeout(NaN)` throws `TypeError: Value NaN is outside the range`, which `postOtlp`
 * catches and logs — so every export fails and the traces stop, one warn line at a time.
 */
describe('otlpSpanExporter refuses a bound that is not a bound', () => {
  const ENDPOINT = 'http://collector:4318';

  test('a NaN flush interval is refused, never a 1ms timer', () => {
    expect(() => otlpSpanExporter({ endpoint: ENDPOINT, flushIntervalMs: Number.NaN })).toThrow(
      /X_INVARIANT/,
    );
  });

  test('every numeric option is screened, and each names itself', () => {
    for (const option of [
      'maxBatchSize',
      'maxQueueSize',
      'timeoutMs',
      'flushIntervalMs',
    ] as const) {
      expect(() => otlpSpanExporter({ endpoint: ENDPOINT, [option]: Number.NaN })).toThrow(
        new RegExp(option),
      );
      expect(() => otlpSpanExporter({ endpoint: ENDPOINT, [option]: 0 })).toThrow(/X_INVARIANT/);
    }
  });

  test('an exporter that states nothing still builds', () => {
    const exporter = otlpSpanExporter({
      endpoint: ENDPOINT,
      fetch: stubFetch(async () => new Response('{}')),
    });
    expect(typeof exporter.flush).toBe('function');
    void exporter.shutdown();
  });
});
