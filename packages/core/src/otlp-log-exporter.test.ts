// OTLP logs: the `/v1/logs` JSON shape a collector accepts (severity bands, nanosecond strings, hex
// trace correlation), and the whole path — a `log.record` subscriber batching what the logger wrote.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetInstrumentation, subscribe } from './instrument';
import type { LogRecordEvent } from './instrument-events';
import { logger, setLogSink } from './logger';
import { otlpEndpoint } from './otlp';
import { otlpLogExporter, otlpLogsRequest } from './otlp-log-exporter';
import { alwaysOnSampler } from './sampler';
import { configureTelemetry, resetTelemetry, withSpan } from './telemetry';

afterEach(() => {
  resetInstrumentation();
  resetTelemetry();
});

const RESOURCE = { serviceName: 'web', serviceVersion: '1.2.0' };
const SPAN = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: 1,
};

const record = (overrides: Partial<LogRecordEvent> = {}): LogRecordEvent => ({
  at: 1_767_225_600_050,
  level: 'warn',
  message: 'payment.retry',
  fields: { attempt: 2, ok: false, order: { id: 'o1' }, gone: undefined },
  ...overrides,
});

const capture = () => {
  const bodies: string[] = [];
  const urls: string[] = [];
  const fetch = Object.assign(
    (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      urls.push(String(url));
      bodies.push(String(init?.body ?? ''));
      return Promise.resolve(new Response('', { status: 200 }));
    },
    { preconnect: (): void => {} },
  );
  return { bodies, urls, fetch };
};

describe('otlpLogsRequest', () => {
  test('is the OTLP/JSON logs shape: severity band, body, attributes, trace ids', () => {
    expect(otlpLogsRequest([{ record: record(), span: SPAN }], RESOURCE)).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'web' } },
              { key: 'service.version', value: { stringValue: '1.2.0' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: '@ultimat3/core' },
              logRecords: [
                {
                  timeUnixNano: '1767225600050000000',
                  observedTimeUnixNano: '1767225600050000000',
                  severityNumber: 13,
                  severityText: 'WARN',
                  body: { stringValue: 'payment.retry' },
                  attributes: [
                    { key: 'attempt', value: { intValue: '2' } },
                    { key: 'ok', value: { boolValue: false } },
                    { key: 'order', value: { stringValue: '{"id":"o1"}' } },
                  ],
                  traceId: SPAN.traceId,
                  spanId: SPAN.spanId,
                  flags: 1,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test('a context-only trace (empty span id) correlates on the trace id alone', () => {
    const body = otlpLogsRequest(
      [{ record: record({ level: 'fatal' }), span: { ...SPAN, spanId: '' } }],
      RESOURCE,
    ) as { resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] };
    const [only] = body.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
    expect(only?.['traceId']).toBe(SPAN.traceId);
    expect(only).not.toHaveProperty('spanId');
    expect(only?.['severityNumber']).toBe(21);
  });
});

describe('otlpLogExporter on the bus', () => {
  test('resolves /v1/logs from the generic endpoint', () => {
    expect(otlpEndpoint('logs', undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' })).toBe(
      'http://c:4318/v1/logs',
    );
  });

  test('a line written inside a span reaches the collector carrying that span', async () => {
    const sink = capture();
    const logs = otlpLogExporter({ endpoint: 'http://c:4318/v1/logs', fetch: sink.fetch });
    const off = subscribe('log.record', (event) => logs.export(event.payload));
    configureTelemetry({ sampler: alwaysOnSampler });
    const previous = setLogSink(() => undefined);
    let spanId = '';
    try {
      withSpan('job.perform', (span) => {
        spanId = span.context.spanId;
        logger.warn('charge.declined', { order: 'o1' });
      });
      // The exporter's own complaints never feed back into the exporter.
      logger.warn('otlp export failed', { url: 'http://c:4318/v1/logs' });
    } finally {
      setLogSink(previous);
      off();
    }
    await logs.shutdown();
    expect(sink.urls).toEqual(['http://c:4318/v1/logs']);
    const sent = JSON.parse(sink.bodies[0] ?? '{}') as {
      resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[];
    };
    const records = sent.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
    expect(records.map((one) => one['body'])).toEqual([{ stringValue: 'charge.declined' }]);
    expect(records[0]?.['spanId']).toBe(spanId);
  });
});
