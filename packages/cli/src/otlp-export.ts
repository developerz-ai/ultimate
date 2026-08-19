// OTLP export, switched on by the variable the shipped Helm chart already sets. Until this file
// `OTEL_EXPORTER_OTLP_ENDPOINT` was in `docker/helm/values.yaml` and **no code read it**: a
// deployment configured a collector, the collector received nothing, and the only signal that
// anything was wrong was an empty dashboard.

import {
  configureMetrics,
  configureTelemetry,
  logger,
  noopExporter,
  noopMetricExporter,
  onShutdown,
  otlpMetricExporter,
  otlpSpanExporter,
  startMetricExport,
  tryOtlpEndpoint,
} from '@ultimat3/core';
import type { Env } from './dev-services';

/** How often counters are pushed. Core's own default; named here because the boot chose it. */
export const METRIC_EXPORT_INTERVAL_MS = 60_000;

/**
 * Install whichever exporters an endpoint was configured for, and return the release.
 *
 * `tryOtlpEndpoint` is asked FIRST, per signal, because both constructors throw
 * `X_OTLP_ENDPOINT_INVALID` when nothing configured one — deliberately, so that a telemetry
 * exporter can never silently send nowhere. Asking is what makes the exporter optional without
 * making it silent.
 *
 * Both are registered with `onShutdown(..., { phase: 'close' })`: the last spans of a drain are
 * the ones that explain the drain, and a process that exits with a full queue loses exactly the
 * window an operator went looking for.
 *
 * The release UNINSTALLS what it installed, per signal. `configureTelemetry`/`configureMetrics`
 * merge into process-global state, so stopping the timer and dropping the drain hooks left the
 * first boot's exporter configured: a second `serveApp` in the same process exported its spans
 * into a released exporter — queued against a collector nothing will flush to, on a timer nothing
 * clears. `cmd-dev.ts`'s `stop()` hands back `noopExporter` for exactly this reason. Per signal and
 * never unconditionally: `x dev` configures a trace RECORDER before calling this, and a boot that
 * installed no exporter must not uninstall one it never owned.
 */
export function startOtlpExport(env: Env = process.env): () => void {
  const releases: (() => void)[] = [];

  // The boot's OWN env, not `process.env`, and the resolved endpoint is then passed to the
  // exporter explicitly: `runRole({ env })` is a real seam — a test and an in-process host both
  // pass an env that is not the process's — and an exporter that re-read `process.env` would
  // answer a different question from the one this function just asked.
  const traces = tryOtlpEndpoint('traces', env);
  if (traces !== undefined) {
    const exporter = otlpSpanExporter({ endpoint: traces });
    configureTelemetry({ exporter });
    // Pushed first, so the reversed run below applies it LAST — after the drain hook is dropped,
    // the same order `cmd-dev.ts` releases the recorder in.
    releases.push(() => configureTelemetry({ exporter: noopExporter }));
    releases.push(onShutdown('otlp-traces', () => exporter.shutdown(), { phase: 'close' }));
    logger.info('ultimate otlp traces', { endpoint: traces });
  }

  const metrics = tryOtlpEndpoint('metrics', env);
  if (metrics !== undefined) {
    const exporter = otlpMetricExporter({ endpoint: metrics });
    configureMetrics({ exporter });
    releases.push(() => configureMetrics({ exporter: noopMetricExporter }));
    // The push loop, and not only the exporter: `configureMetrics` names where a snapshot goes
    // and nothing decides when one is taken, so without this the collector receives one export —
    // the drain's — for the whole life of the process.
    const stopTimer = startMetricExport(METRIC_EXPORT_INTERVAL_MS);
    releases.push(stopTimer);
    releases.push(onShutdown('otlp-metrics', () => exporter.flush(), { phase: 'close' }));
    logger.info('ultimate otlp metrics', { endpoint: metrics });
  }

  return () => {
    for (const release of releases.reverse()) release();
  };
}
