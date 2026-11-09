// OTLP export, switched on by the variable the shipped Helm chart already sets. Until this file
// `OTEL_EXPORTER_OTLP_ENDPOINT` was in `docker/helm/values.yaml` and **no code read it**: a
// deployment configured a collector, the collector received nothing, and the only signal that
// anything was wrong was an empty dashboard.

import type { OtlpSignal, ShutdownReason } from '@ultimat3/core';
import {
  configureMetrics,
  logger,
  noopMetricExporter,
  onShutdown,
  otlpEndpointLabel,
  otlpLogExporter,
  otlpMetricExporter,
  otlpSpanExporter,
  startMetricExport,
  subscribe,
  subscribeSemconvMetrics,
  systemClock,
  tryOtlpEndpoint,
} from '@ultimat3/core';
import type { Env } from './runtime-bindings';

/**
 * The endpoint a signal exports to, unless `OTEL_<SIGNAL>_EXPORTER=none` switched it off or
 * `OTEL_SDK_DISABLED=true` switched every signal off — the OpenTelemetry spellings, read as the
 * spec does: case-insensitive, surrounding space ignored (`NONE`, `none `). The generic
 * `OTEL_EXPORTER_OTLP_ENDPOINT` names all three signals, and a collector with no logs pipeline
 * would answer every logs batch with a 404.
 */
export function signalEndpoint(signal: OtlpSignal, env: Env): string | undefined {
  if (envWord(env['OTEL_SDK_DISABLED']) === 'true') return undefined;
  if (envWord(env[`OTEL_${signal.toUpperCase()}_EXPORTER`]) === 'none') return undefined;
  return tryOtlpEndpoint(signal, env);
}

const envWord = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

/** How often counters are pushed. Core's own default; named here because the boot chose it. */
export const METRIC_EXPORT_INTERVAL_MS = 60_000;

/**
 * Install whichever exporters an endpoint was configured for — traces, metrics, logs — plus the
 * semconv histograms every boot records, and return the release.
 *
 * `tryOtlpEndpoint` is asked FIRST, per signal, because both constructors throw
 * `X_OTLP_ENDPOINT_INVALID` when nothing configured one — deliberately, so that a telemetry
 * exporter can never silently send nowhere. Asking is what makes the exporter optional without
 * making it silent.
 *
 * ONE drain hook flushes every signal, in PARALLEL and capped at what is left of the drain's
 * deadline (`flushWithin`): three hooks in turn, each waiting out its own 10 s export budget against
 * a black-holed collector, overran a 25 s drain and turned a clean exit into `X_SHUTDOWN_TIMEOUT`.
 * `phase: 'close'`: the last spans of a drain are the ones that explain it. That phase runs
 * last-registered first, so the boot calls this BEFORE anything whose teardown should be seen.
 *
 * The release UNINSTALLS what it installed, per signal. Spans are a `span.end` SUBSCRIPTION on
 * core's instrumentation bus and the release is its unsubscribe, so a second `serveApp` in the same
 * process never exports into a released exporter, and `x dev`'s trace RECORDER — its own subscriber
 * — is untouched. Each exporter is SHUT DOWN before it is unsubscribed — its queued batch goes out
 * and its timer stops, rather than being dropped and leaked. `configureMetrics` still merges into
 * process-global state, so its release hands back `noopMetricExporter`.
 */
export function startOtlpExport(env: Env = process.env): () => void {
  const releases: (() => void)[] = [];
  const flushes: (() => Promise<void>)[] = [];

  // Every boot, collector or not: the semconv histograms (`db_client_operation_duration_seconds`,
  // `job_duration_seconds`, `gen_ai_client_token_usage`) are bus subscribers, and `/metrics` serves
  // them to a scrape-only deployment exactly as OTLP pushes them to a collector. Pushed first, so
  // the reversed release below drops them last — the drain's own statements are still counted.
  releases.push(subscribeSemconvMetrics());

  // The boot's OWN env, not `process.env`, and the resolved endpoint is then passed to the
  // exporter explicitly: `runRole({ env })` is a real seam — a test and an in-process host both
  // pass an env that is not the process's — and an exporter that re-read `process.env` would
  // answer a different question from the one this function just asked.
  const traces = signalEndpoint('traces', env);
  if (traces !== undefined) {
    const exporter = otlpSpanExporter({ endpoint: traces });
    // Pushed first, so the reversed run below applies it LAST — after the drain hook is dropped,
    // the same order `dev-boot.ts` releases the recorder in.
    releases.push(subscribe('span.end', (event) => exporter.export(event.payload)));
    releases.push(() => void exporter.shutdown());
    flushes.push(() => exporter.shutdown());
    logger.info('ultimate otlp traces', { endpoint: otlpEndpointLabel(traces) });
  }

  const metrics = signalEndpoint('metrics', env);
  if (metrics !== undefined) {
    const exporter = otlpMetricExporter({ endpoint: metrics });
    configureMetrics({ exporter });
    releases.push(() => configureMetrics({ exporter: noopMetricExporter }));
    // The push loop, and not only the exporter: `configureMetrics` names where a snapshot goes
    // and nothing decides when one is taken, so without this the collector receives one export —
    // the drain's — for the whole life of the process.
    const stopTimer = startMetricExport(METRIC_EXPORT_INTERVAL_MS);
    releases.push(stopTimer);
    flushes.push(() => exporter.flush());
    logger.info('ultimate otlp metrics', { endpoint: otlpEndpointLabel(metrics) });
  }

  const logs = signalEndpoint('logs', env);
  if (logs !== undefined) {
    const exporter = otlpLogExporter({ endpoint: logs });
    // Synchronously inside the handler: the exporter reads the ACTIVE span there, which is what
    // joins a log line to its trace in the collector. Only the process logger's lines reach the
    // bus, after redaction — never a logger given its own writer.
    releases.push(subscribe('log.record', (event) => exporter.export(event.payload)));
    releases.push(() => void exporter.shutdown());
    flushes.push(() => exporter.shutdown());
    logger.info('ultimate otlp logs', { endpoint: otlpEndpointLabel(logs) });
  }

  if (flushes.length > 0) {
    releases.push(onShutdown('otlp', (reason) => flushWithin(flushes, reason), { phase: 'close' }));
  }

  return () => {
    for (const release of releases.reverse()) release();
  };
}

/**
 * What is left of the drain's budget a flush may spend: most of it, so the hooks behind this one
 * and the exit still fit. Real monotonic time, as `ShutdownReason.deadlineAt` is.
 */
export const OTLP_FLUSH_SHARE = 0.8;

/** Every signal's flush at once, abandoned (not awaited further) when the share is spent. */
export async function flushWithin(
  flushes: readonly (() => Promise<void>)[],
  reason: Pick<ShutdownReason, 'deadlineAt'>,
): Promise<void> {
  const budget = Math.max(0, (reason.deadlineAt - systemClock.monotonic()) * OTLP_FLUSH_SHARE);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spent = new Promise<'spent'>((resolve) => {
    timer = setTimeout(() => resolve('spent'), budget);
    timer.unref();
  });
  const all = Promise.allSettled(flushes.map((flush) => flush())).then(() => 'flushed' as const);
  const outcome = await Promise.race([all, spent]);
  clearTimeout(timer);
  if (outcome === 'spent') {
    logger.warn('otlp flush abandoned at the drain deadline', { signals: flushes.length });
  }
}
