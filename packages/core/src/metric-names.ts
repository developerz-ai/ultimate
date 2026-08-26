// Single responsibility: the identifier grammar every metric name and every LABEL name obeys, and
// the one code that refuses a value outside it. Split out of `metrics.ts` because that file is at
// the 500-line ceiling `x verify`'s `filesize` step enforces, and because the two refusals are one
// rule asked of two things — the exposition format spells them identically.

import { type CodedErrorInit, UltimateError } from './errors';
import type { MetricAttributes } from './metrics-types';

export class MetricNameInvalidError extends UltimateError {
  static readonly code = 'X_METRIC_NAME_INVALID';
  override readonly name = 'MetricNameInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: MetricNameInvalidError.code });
  }
}

/**
 * Lowercase snake, the intersection of what every exposition format accepts. OTel's dotted names
 * survive an OTLP hop but not a Prometheus scrape, and the autoscaler reads the scrape.
 */
export const METRIC_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * The suggestion both `fix:` lines below hand back, and it has to SATISFY `METRIC_NAME_RE`, not
 * merely resemble it: the grammar's first character is `[a-z_]`, so lowercasing `2digits` left
 * `2digits` and the refusal told the caller to rename the label to the same name it had just
 * refused. An underscore prefix is the one repair that keeps the rest of the identifier — which is
 * also what makes the empty string a nameable `_` rather than a second refusal.
 */
const snake = (value: string): string => {
  const lowered = value.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_');
  return /^[a-z_]/.test(lowered) ? lowered : `_${lowered}`;
};

/** Refused at DECLARATION, where the instrument is still nameable. */
export function assertMetricName(name: string): void {
  if (METRIC_NAME_RE.test(name)) return;
  throw new MetricNameInvalidError({
    cause: `"${name}" is not lowercase snake_case matching ${METRIC_NAME_RE.source}`,
    fix: `rename the instrument to lowercase snake_case, e.g. ${snake(name)}`,
    meta: { name },
  });
}

/**
 * A LABEL name obeys that same grammar, and it was guarded nowhere: `metrics-text.ts` escapes the
 * label VALUE and interpolates the KEY raw, so `bad"key` rendered `orders_total{bad"key="x"} 1`
 * and a `\n` in one split the body into a line the scraper reads as a different series. A scraper
 * rejects the WHOLE response over one unparseable line, so `http_requests_total`, `connections`
 * and `queue_depth` — the three the chart's HPA reads — disappear together, and the autoscaler
 * sees no signal rather than a bad one.
 *
 * Refused on the way in, never sanitised at render: a silently renamed label is a different
 * series, and the point would land somewhere the dashboard querying the declared name cannot see.
 * Once per label set the instrument has not seen — `seriesFor` calls this on its MISS, ahead of
 * the cardinality ceiling, because the overflow branch answers without allocating a series and a
 * check hung off the allocation would have made the refusal a function of how busy the process is.
 */
export function assertLabelNames(metric: string, attributes: MetricAttributes): void {
  for (const label of Object.keys(attributes)) {
    if (METRIC_NAME_RE.test(label)) continue;
    throw new MetricNameInvalidError({
      cause: `${metric} was given the label "${label}", which is not lowercase snake_case matching ${METRIC_NAME_RE.source} — the exposition line it renders is one no scraper can parse, and one bad line drops the whole scrape`,
      fix: `rename the label at the call site to lowercase snake_case, e.g. { ${snake(label)}: … }`,
      meta: { metric, label },
    });
  }
}
