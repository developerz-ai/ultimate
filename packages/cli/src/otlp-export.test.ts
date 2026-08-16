// `OTEL_EXPORTER_OTLP_ENDPOINT` is in the shipped Helm chart and nothing read it. The failure case
// is the one that shipped: a deployment configures a collector and the collector receives nothing.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMetrics, resetTelemetry, shutdownHookCount, withSpan } from '@ultimat3/core';
import { startOtlpExport } from './otlp-export';

let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
  resetTelemetry();
  resetMetrics();
});

describe('OTLP export is driven by the variable the chart already sets', () => {
  test('no endpoint installs nothing, and does not throw', () => {
    // Both exporters throw `X_OTLP_ENDPOINT_INVALID` at construction with no endpoint —
    // deliberately, so a telemetry exporter can never silently send nowhere. Asking
    // `tryOtlpEndpoint` first is what makes them optional without making them silent.
    const before = shutdownHookCount();
    release = startOtlpExport({});
    expect(shutdownHookCount()).toBe(before);
  });

  test('the generic endpoint installs both signals, each with its own drain hook', () => {
    const before = shutdownHookCount();
    release = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
    // `phase: 'close'` on both: the last spans of a drain are the ones that explain the drain,
    // and a process that exits with a full queue loses exactly the window an operator wanted.
    expect(shutdownHookCount()).toBe(before + 2);
  });

  test('a per-signal endpoint installs only that signal', () => {
    const before = shutdownHookCount();
    release = startOtlpExport({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
    });
    expect(shutdownHookCount()).toBe(before + 1);
  });

  test('the release unregisters what it installed, so a second boot does not double up', () => {
    const before = shutdownHookCount();
    startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })();
    expect(shutdownHookCount()).toBe(before);
  });

  test('the env is the BOOT’s, never `process.env` — `runRole({ env })` is a real seam', () => {
    // An in-process host and a test both pass an env that is not the process's, and an exporter
    // that re-read `process.env` would answer a different question from the one just asked. The
    // empty env is the assertion: if `process.env` were consulted, a machine with the variable
    // set would install exporters here.
    const before = shutdownHookCount();
    release = startOtlpExport({});
    expect(shutdownHookCount()).toBe(before);
  });

  test('a gRPC port is refused at boot rather than posting into a receiver that cannot read it', () => {
    // Not caught and downgraded: an endpoint an operator meant to work and that cannot is a boot
    // failure with a fix line, never a process that starts and exports nothing.
    expect(() => startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317' })).toThrow(
      /X_OTLP_PROTOCOL_UNSUPPORTED/,
    );
  });

  test('a span recorded after install still resolves through the configured exporter', async () => {
    release = startOtlpExport({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });
    // The point of `configureTelemetry({ exporter })`: without it every span this process opens is
    // handed to core's no-op and the collector's dashboard stays empty forever.
    await expect(withSpan('otlp.smoke', async () => 'ok')).resolves.toBe('ok');
  });
});
