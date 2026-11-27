// The service identity every signal carries (#1361): no invented `ultimate`/`0.0.1` — unset is
// OTel's own `unknown_service` and the unnamed build `APP_VERSION` already answers (`dev`) — and
// `resetTelemetry` forgets a configured identity like it forgets a sampler.
import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_APP_VERSION } from './app-version';
import { resetInstrumentation, subscribe } from './instrument';
import {
  configureTelemetry,
  memoryExporter,
  resetTelemetry,
  serviceResource,
  startSpan,
} from './telemetry';

afterEach(() => {
  resetTelemetry();
  resetInstrumentation();
});

describe('unit · the service resource', () => {
  test('unconfigured, it is the OTel default name and the unnamed build — never a made-up app', () => {
    expect(serviceResource()).toEqual({
      serviceName: 'unknown_service',
      serviceVersion: DEFAULT_APP_VERSION,
    });
  });

  test('configured halves merge: a version alone keeps the name said before it', () => {
    configureTelemetry({ serviceName: 'shop' });
    configureTelemetry({ serviceVersion: 'b-42' });
    expect(serviceResource()).toEqual({ serviceName: 'shop', serviceVersion: 'b-42' });
  });

  test('an ended span carries the resource in force when it was recorded', () => {
    const exporter = memoryExporter();
    subscribe('span.end', (event) => exporter.export(event.payload));
    configureTelemetry({ serviceName: 'shop', serviceVersion: 'b-42' });
    startSpan('boot').end();
    expect(exporter.spans[0]?.resource).toEqual({ serviceName: 'shop', serviceVersion: 'b-42' });
  });

  test('resetTelemetry forgets the identity, so a second boot in one process starts clean', () => {
    configureTelemetry({ serviceName: 'shop', serviceVersion: 'b-42' });
    resetTelemetry();
    expect(serviceResource()).toEqual({
      serviceName: 'unknown_service',
      serviceVersion: DEFAULT_APP_VERSION,
    });
  });

  // The boot's release (`serve-boot-telemetry.ts`): a stopped boot hands the process back the
  // identity it found, never the one it set — and never resets a clock or sampler it did not set.
  test('configureTelemetry returns the release that restores what it replaced', () => {
    configureTelemetry({ serviceName: 'shop', serviceVersion: 'b-1' });
    const release = configureTelemetry({ serviceName: 'worker' });
    expect(serviceResource().serviceName).toBe('worker');
    release();
    expect(serviceResource()).toEqual({ serviceName: 'shop', serviceVersion: 'b-1' });
  });
});
