// Single responsibility: a span's recorded failure honours `redactValues()` — the exception
// event's `error.message` and the status message are what an OTLP collector receives.

import { afterEach, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { resetInstrumentation, subscribe } from './instrument';
import { redactValues } from './logger';
import { alwaysOnSampler } from './sampler';
import {
  configureTelemetry,
  memoryExporter,
  resetTelemetry,
  startSpan,
  withSpan,
} from './telemetry';

afterEach(() => {
  resetTelemetry();
  resetInstrumentation();
});

test('a registered pattern never reaches the exception event or the status message', () => {
  redactValues([{ pattern: /rvspan_\d{8}/g, replace: '[acct]' }]);
  configureTelemetry({ sampler: alwaysOnSampler });
  const exporter = memoryExporter();
  subscribe('span.end', (event) => exporter.export(event.payload));

  expect(() =>
    withSpan('charge', () => {
      throw new UltimateError({
        code: 'X_ENVELOPE_FIXTURE',
        cause: 'charge failed for rvspan_12345678',
        fix: 'retry the charge',
      });
    }),
  ).toThrow('rvspan_12345678');
  const manual = startSpan('refund');
  manual.setStatus('error', 'refund refused for rvspan_87654321');
  manual.end();

  const text = JSON.stringify(exporter.spans);
  expect(text).not.toMatch(/rvspan_\d{8}/);
  expect(exporter.spans[0]?.events[0]?.attributes['error.message']).toContain('[acct]');
  expect(exporter.spans[0]?.status.message).toContain('[acct]');
  expect(exporter.spans[1]?.status.message).toBe('refund refused for [acct]');
});
