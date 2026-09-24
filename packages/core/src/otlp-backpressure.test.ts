// Single responsibility: what the OTLP exporters HOLD while a collector stalls. `maxQueueSize` was a
// bound on the queue and not on memory: every drain moved the whole queue into a promise chain
// behind the hung POST, so 100k spans exported with `maxQueueSize: 2048` were all retained.

import { describe, expect, test } from 'bun:test';
import type { MetricCollection } from './metrics';
import { otlpMetricExporter } from './otlp-metric-exporter';
import { otlpSpanExporter } from './otlp-span-exporter';
import type { ReadableSpan } from './telemetry';

const RESOURCE = { serviceName: 'web', serviceVersion: '1.2.0' };

const span = (index: number): ReadableSpan => ({
  name: `span-${index}`,
  kind: 'internal',
  context: {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: 1,
  },
  parentSpanId: undefined,
  startedAt: 1_767_225_600_000,
  endedAt: 1_767_225_600_001,
  durationMs: 1,
  attributes: {},
  events: [],
  status: { code: 'ok' },
  links: [],
  resource: RESOURCE,
});

/** A collector that answers nothing until `release()`, recording every body it was sent. */
function stalledCollector() {
  const bodies: string[] = [];
  const waiting: (() => void)[] = [];
  let stalled = true;
  const fetch = Object.assign(
    (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(String(init?.body ?? ''));
      if (!stalled) return Promise.resolve(new Response('', { status: 200 }));
      return new Promise<Response>((resolve) => {
        waiting.push(() => resolve(new Response('', { status: 200 })));
      });
    },
    { preconnect: (): void => {} },
  ) as typeof globalThis.fetch;
  return {
    fetch,
    bodies,
    release: (): void => {
      stalled = false;
      for (const resume of waiting.splice(0)) resume();
    },
  };
}

const spansIn = (body: string): number => {
  const parsed = JSON.parse(body) as {
    resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
  };
  return parsed.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0;
};

describe('a stalled collector', () => {
  test('span exporter: at most one batch in flight, the rest bounded by maxQueueSize', async () => {
    const collector = stalledCollector();
    const exporter = otlpSpanExporter({
      endpoint: 'http://collector:4318/v1/traces',
      maxQueueSize: 2048,
      maxBatchSize: 512,
      timeoutMs: 60_000,
      fetch: collector.fetch,
    });
    for (let index = 0; index < 100_000; index += 1) exporter.export(span(index));
    await Bun.sleep(0);
    // One POST is hung; nothing else was taken off the queue behind it.
    expect(collector.bodies).toHaveLength(1);

    collector.release();
    await exporter.shutdown();
    const sent = collector.bodies.reduce((total, body) => total + spansIn(body), 0);
    // Everything retained while stalled: the one batch in flight plus a full queue — never 100k.
    expect(sent).toBeLessThanOrEqual(2048 + 512);
    // And the newest span survived the drop-oldest: it is the last one sent.
    expect(collector.bodies.at(-1)).toContain('span-99999');
    for (const body of collector.bodies) expect(spansIn(body)).toBeLessThanOrEqual(512);
  });

  test('metric exporter: one snapshot in flight and only the NEWEST waiting behind it', async () => {
    const collector = stalledCollector();
    const exporter = otlpMetricExporter({
      endpoint: 'http://collector:4318/v1/metrics',
      startedAtMs: 1,
      timeoutMs: 60_000,
      fetch: collector.fetch,
    });
    const snapshot = (value: number): MetricCollection => ({
      at: 1_767_225_600_000 + value,
      resource: RESOURCE,
      metrics: [
        {
          descriptor: { name: 'jobs_total', kind: 'counter', unit: '1', description: 'jobs' },
          points: [{ attributes: {}, value }],
        },
      ],
    });
    // Cumulative snapshots: a newer one supersedes every older one still waiting.
    for (let value = 1; value <= 10_000; value += 1) exporter.export(snapshot(value));
    await Bun.sleep(0);
    expect(collector.bodies).toHaveLength(1);

    collector.release();
    await exporter.flush();
    expect(collector.bodies).toHaveLength(2);
    expect(collector.bodies[1]).toContain('"asDouble":10000');
  });
});
