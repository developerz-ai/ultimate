// The two ids are read here, before the context and before the root span. They used to be read
// by a stage that ran one frame after `withSpan` froze the span's parent, so the caller's trace
// was discarded and the span carried a UUIDv7 — not a 32-hex W3C id — that no collector accepts
// and no log line beside it mentioned.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { readCorrelation } from './correlation';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const config = (trust: boolean) =>
  defineHttpConfig({
    rateLimit: { scope: 'process' },
    ...(trust ? { trustProxy: true, trustedProxyHops: 1 } : {}),
  });

const read = (headers: Record<string, string>, trust = false) =>
  readCorrelation(new Headers(headers), config(trust));

describe('readCorrelation', () => {
  test('an inbound traceparent is continued: same trace, the caller as parent', () => {
    const correlation = read({ traceparent: TRACEPARENT });
    expect(correlation.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(correlation.parentSpanId).toBe('00f067aa0ba902b7');
    expect(correlation.parent?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  // The second half of the same defect: `uuid()` produced `01a00ac1-92d6-...`, which is dashed,
  // 36 characters and not hex — a trace id an OTLP collector rejects outright.
  test('with no traceparent the trace id is 32 hex characters, never a UUID', () => {
    const correlation = read({});
    expect(correlation.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(correlation.parent).toBeUndefined();
    expect(correlation.parentSpanId).toBeNull();
  });

  test('a malformed traceparent starts a fresh trace rather than throwing', () => {
    const correlation = read({ traceparent: 'not-a-traceparent' });
    expect(correlation.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(correlation.parent).toBeUndefined();
  });

  test('an inbound x-request-id is echoed only when a proxy is trusted', () => {
    expect(read({ 'x-request-id': 'req-abc-123456' }).requestId).not.toBe('req-abc-123456');
    expect(read({ 'x-request-id': 'req-abc-123456' }, true).requestId).toBe('req-abc-123456');
  });

  test('a trusted but implausible request id is still refused', () => {
    expect(read({ 'x-request-id': 'short' }, true).requestId).not.toBe('short');
    expect(read({ 'x-request-id': 'a'.repeat(200) }, true).requestId.length).toBeLessThan(200);
  });
});
