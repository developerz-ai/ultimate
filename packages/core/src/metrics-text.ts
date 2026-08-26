// Single responsibility: render a `MetricCollection` as the Prometheus/OpenMetrics text format —
// the payload behind `/metrics`. A serialisation, not a vendor: it is what a Kubernetes metric
// adapter, a Grafana Agent, a Datadog agent and an OTel collector all already read (axiom 7).

import type { MetricAttributes, MetricPoint, ReadableMetric } from './metrics';
import { collectMetrics, type HistogramPoint, type MetricCollection } from './metrics';

export const METRICS_PATH = '/metrics';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** The exposition format escapes exactly these three, and nothing else. */
function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/**
 * The KEY is interpolated bare and the VALUE is escaped, which is the whole grammar: a label name
 * is an identifier `metrics.ts` refuses at series creation (`X_METRIC_NAME_INVALID`), a label
 * value is arbitrary text. Never sanitise a key here — a renamed label is a different series, and
 * this function has no way to tell the dashboard that.
 */
function labels(attributes: MetricAttributes, extra?: readonly [string, string]): string {
  const pairs = Object.entries(attributes)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}="${escapeLabel(String(value))}"`);
  if (extra !== undefined) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

/** `+Inf` and `NaN` are spelled out; everything else is plain decimal. */
function number(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return Number.isNaN(value) ? 'NaN' : String(value);
}

function isHistogramPoint(point: MetricPoint): point is HistogramPoint {
  return 'buckets' in point;
}

/**
 * A histogram renders as three families — `_bucket`, `_sum`, `_count` — with CUMULATIVE bucket
 * counts. Storing them cumulatively instead would make every record a loop over the bounds.
 */
function histogramLines(name: string, point: HistogramPoint): readonly string[] {
  const lines: string[] = [];
  let running = 0;
  point.bounds.forEach((bound, index) => {
    running += point.buckets[index] ?? 0;
    lines.push(`${name}_bucket${labels(point.attributes, ['le', number(bound)])} ${running}`);
  });
  running += point.buckets[point.bounds.length] ?? 0;
  lines.push(`${name}_bucket${labels(point.attributes, ['le', '+Inf'])} ${running}`);
  lines.push(`${name}_sum${labels(point.attributes)} ${number(point.value)}`);
  lines.push(`${name}_count${labels(point.attributes)} ${point.count}`);
  return lines;
}

function metricLines(metric: ReadableMetric): readonly string[] {
  const { name, kind, description, unit } = metric.descriptor;
  const help = unit === '1' || unit === '' ? description : `${description} (${unit})`;
  const lines = [`# HELP ${name} ${escapeLabel(help)}`, `# TYPE ${name} ${kind}`];
  for (const point of metric.points) {
    if (kind === 'histogram' && isHistogramPoint(point)) {
      lines.push(...histogramLines(name, point));
      continue;
    }
    lines.push(`${name}${labels(point.attributes)} ${number(point.value)}`);
  }
  return lines;
}

/**
 * The scrape body. `target_info` carries the service identity as labels, which is how OTel's own
 * Prometheus mapping does it — the alternative is stamping every series with the same two labels.
 */
export function metricsText(collection: MetricCollection = collectMetrics()): string {
  const { serviceName, serviceVersion } = collection.resource;
  const lines = [
    '# HELP target_info the service these metrics describe',
    '# TYPE target_info gauge',
    `target_info{service_name="${escapeLabel(serviceName)}",service_version="${escapeLabel(serviceVersion)}"} 1`,
    ...collection.metrics.flatMap(metricLines),
  ];
  return `${lines.join('\n')}\n`;
}
