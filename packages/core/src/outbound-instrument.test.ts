// `outbound()` on the bus: one `outbound.request` per CALL (retries inside it), a client span named
// `outbound.<vendor>` with semconv attributes, the event fired whether or not the trace is sampled.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { resetInstrumentation, subscribe } from './instrument';
import type { OutboundRequestEvent } from './instrument-events';
import { SEMCONV } from './instrument-semconv';
import { outbound } from './outbound';
import { recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';
import { alwaysOffSampler, alwaysOnSampler } from './sampler';
import type { ReadableSpan } from './telemetry';
import { configureTelemetry, resetTelemetry } from './telemetry';

type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const call = (over: Partial<BytesCall> = {}): BytesCall => ({
  url: 'https://api.vendor.test:8443/v1/items?secret=1',
  vendor: 'resend',
  dial: 'named',
  deadlineMs: 10_000,
  retry: { attempts: 2, base: 0, max: 0, jitter: 'none' },
  ...over,
});

function listen(): { events: OutboundRequestEvent[]; spans: ReadableSpan[] } {
  const events: OutboundRequestEvent[] = [];
  const spans: ReadableSpan[] = [];
  subscribe('outbound.request', (event) => events.push(event.payload));
  subscribe('span.end', (event) => spans.push(event.payload));
  return { events, spans };
}

afterEach(() => {
  resetInstrumentation();
  resetTelemetry();
});

describe('unit · outbound · instrumentation', () => {
  test('a call that answers is one event and one client span with semconv attributes', async () => {
    configureTelemetry({ sampler: alwaysOnSampler });
    const seen = listen();
    let n = 0;
    const { fetch } = recordingFetch(() => {
      n += 1;
      return n === 1 ? new Response('busy', { status: 503 }) : new Response('{}');
    });
    const answer = await outbound(call(), { fetch, sleep: async () => {} });
    expect(answer.status).toBe(200);
    expect(seen.events).toHaveLength(1);
    const [event] = seen.events;
    expect(event).toMatchObject({
      vendor: 'resend',
      method: 'GET',
      host: 'api.vendor.test',
      status: 200,
    });
    expect(event?.error).toBeUndefined();
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    const span = seen.spans.find((candidate) => candidate.name === 'outbound.resend');
    expect(span?.kind).toBe('client');
    expect(span?.attributes).toMatchObject({
      [SEMCONV.serverAddress]: 'api.vendor.test',
      [SEMCONV.serverPort]: 8443,
      [SEMCONV.httpRequestMethod]: 'GET',
      [SEMCONV.httpResponseStatusCode]: 200,
    });
    // The query string is a credential carrier: it rides neither the span nor the event.
    expect(JSON.stringify(span?.attributes)).not.toContain('secret');
  });

  test('a refused call carries its status and its coded error, and the span is an error', async () => {
    configureTelemetry({ sampler: alwaysOnSampler });
    const seen = listen();
    const { fetch } = recordingFetch(() => new Response('no', { status: 422 }));
    const thrown = await outbound(call({ method: 'PUT' }), { fetch }).catch((error) => error);
    expect(isUltimateError(thrown)).toBe(true);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.status).toBe(422);
    expect(seen.events[0]?.error).toBe(thrown);
    const span = seen.spans.find((candidate) => candidate.name === 'outbound.resend');
    expect(span?.status.code).toBe('error');
    expect(span?.attributes[SEMCONV.httpResponseStatusCode]).toBe(422);
  });

  test('a call that got no answer has no status', async () => {
    const seen = listen();
    const refused = new TypeError('connection refused');
    const { fetch } = recordingFetch(() => {
      throw refused;
    });
    await outbound(call({ retry: { attempts: 1, base: 0, max: 0, jitter: 'none' } }), {
      fetch,
    }).catch(() => undefined);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.status).toBeUndefined();
    expect(seen.events[0]?.error).toBeDefined();
  });

  test('an unsampled trace still emits the event, and exports no span', async () => {
    configureTelemetry({ sampler: alwaysOffSampler });
    const seen = listen();
    const { fetch } = recordingFetch(() => new Response('{}'));
    await outbound(call(), { fetch });
    expect(seen.events).toHaveLength(1);
    expect(seen.spans).toEqual([]);
  });
});
