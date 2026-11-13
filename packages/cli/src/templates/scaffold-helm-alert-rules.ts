// The rule table every Ultimate chart's alerts are written from, renderer-neutral. Only mechanism
// ships (axiom 8): a stalled queue, a dead letter, a lost lease, a dropped frame, error-budget burn,
// job failures, pool, loop and memory saturation, a dead target. A latency target is the app's.

/** How an expression names a series and groups its result, per renderer. */
export interface AlertScope {
  /** `name{matchers}` — the scope's own matchers, then `extra`. */
  readonly series: (name: string, extra?: string) => string;
  /** The labels every rule groups by, so one release (or one job) fires one alert. */
  readonly by: string;
  /** The label naming a scrape target's role. */
  readonly component: string;
  /** The label naming one scrape target — a pod, or a plain `instance`. */
  readonly target: string;
  /** The rule's threshold, as the renderer spells it: a value lookup or the default. */
  readonly threshold: (fallback: number) => string;
  /** The error budget as a PromQL scalar: `(1 - <objective> / 100)`. */
  readonly budget: string;
}

export interface ChartAlert {
  readonly alert: string;
  readonly expr: (scope: AlertScope) => string;
  /** The default `alerts.rules.<alert>.threshold`, for a rule whose comparison is a number. */
  readonly threshold?: number;
  readonly for: string;
  readonly severity: 'warning' | 'critical';
  readonly summary: string;
  /** The heading in `docs/ops/06-runbooks.md` the rule's `runbook_url` lands on. */
  readonly anchor: string;
}

/** `alerts.objective`'s default: the share of requests, in percent, answered without a 5xx. */
export const DEFAULT_OBJECTIVE = 99.9;

/** The PromQL error budget for an objective in percent. */
export const budgetOf = (objective: string): string => `(1 - ${objective} / 100)`;

const rule = (alert: Omit<ChartAlert, 'anchor'>): ChartAlert => ({
  ...alert,
  anchor: alert.alert.toLowerCase(),
});

/** The share of requests answered 5xx over `window`, per release. */
const errorRatio = (s: AlertScope, window: string): string =>
  `(sum by (${s.by}) (rate(${s.series('http_requests_total', 'status="5xx"')}[${window}])) / ` +
  `sum by (${s.by}) (rate(${s.series('http_requests_total')}[${window}])))`;

/**
 * Multi-window burn rate (the SRE workbook's): the long window says the budget is really going,
 * the short one that it still is, so the alert resets minutes after the fault does.
 */
const burn = (s: AlertScope, long: string, short: string, factor: number): string =>
  `${errorRatio(s, long)} > ${s.threshold(factor)} * ${s.budget} and ` +
  `${errorRatio(s, short)} > ${s.threshold(factor)} * ${s.budget}`;

export const CHART_ALERTS: readonly ChartAlert[] = [
  rule({
    alert: 'UltimateQueueStalled',
    threshold: 300,
    expr: (s) =>
      `max by (${s.by}, queue) (${s.series('queue_oldest_ready_seconds')}) > ${s.threshold(300)}`,
    for: '5m',
    severity: 'warning',
    summary: 'A queue has a due job nothing has claimed for longer than the threshold',
  }),
  rule({
    alert: 'UltimateDeadLetters',
    expr: (s) => `max by (${s.by}, queue) (${s.series('queue_dead_jobs')}) > 0`,
    for: '5m',
    severity: 'warning',
    summary: 'A queue holds dead-lettered jobs',
  }),
  rule({
    alert: 'UltimateLeaseLost',
    expr: (s) => `sum by (${s.by}, queue) (rate(${s.series('job_leases_lost_total')}[5m])) > 0`,
    for: '5m',
    severity: 'warning',
    summary: 'Job leases are lapsing while their jobs still run, so jobs run twice',
  }),
  rule({
    alert: 'UltimateFramesDropped',
    expr: (s) => `sum by (${s.by}) (rate(${s.series('channel_frames_dropped_total')}[5m])) > 0`,
    for: '5m',
    severity: 'warning',
    summary: 'Sync nodes are dropping channel frames to socket backpressure',
  }),
  rule({
    alert: 'UltimateServerErrors',
    threshold: 0.05,
    expr: (s) =>
      `sum by (${s.by}) (rate(${s.series('http_requests_total', 'status="5xx"')}[5m])) / ` +
      `sum by (${s.by}) (rate(${s.series('http_requests_total')}[5m])) > ${s.threshold(0.05)}`,
    for: '10m',
    severity: 'critical',
    summary: 'The share of requests answered 5xx is above the threshold',
  }),
  rule({
    alert: 'UltimateErrorBudgetFastBurn',
    threshold: 14.4,
    expr: (s) => burn(s, '1h', '5m', 14.4),
    for: '2m',
    severity: 'critical',
    summary: 'The error budget is burning fast enough to spend 2% of a 30-day budget in an hour',
  }),
  rule({
    alert: 'UltimateErrorBudgetSlowBurn',
    threshold: 6,
    expr: (s) => burn(s, '6h', '30m', 6),
    for: '15m',
    severity: 'warning',
    summary: 'The error budget is burning fast enough to spend 5% of a 30-day budget in six hours',
  }),
  rule({
    alert: 'UltimateJobFailures',
    threshold: 0.1,
    expr: (s) =>
      `sum by (${s.by}, queue) (rate(${s.series('jobs_total', 'outcome=~"failed|dead"')}[15m])) / ` +
      `sum by (${s.by}, queue) (rate(${s.series('jobs_total')}[15m])) > ${s.threshold(0.1)}`,
    for: '15m',
    severity: 'warning',
    summary: "The share of a queue's job runs that fail is above the threshold",
  }),
  rule({
    alert: 'UltimatePoolSaturated',
    threshold: 0,
    expr: (s) =>
      `max by (${s.by}, ${s.target}) (${s.series('db_pool_waiting')}) > ${s.threshold(0)}`,
    for: '5m',
    severity: 'warning',
    summary: 'Statements are queuing for a database connection: the pool is at its ceiling',
  }),
  rule({
    alert: 'UltimateEventLoopLag',
    threshold: 0.5,
    expr: (s) =>
      `histogram_quantile(0.99, sum by (${s.by}, ${s.target}, le) ` +
      `(rate(${s.series('process_event_loop_lag_seconds_bucket')}[5m]))) > ${s.threshold(0.5)}`,
    for: '10m',
    severity: 'warning',
    summary: 'A process runs its timers late: the event loop is blocked or the pod is starved',
  }),
  rule({
    alert: 'UltimateMemoryNearLimit',
    threshold: 0.9,
    expr: (s) =>
      `max by (${s.by}, ${s.target}) (${s.series('process_resident_memory_bytes')} / ` +
      `${s.series('process_memory_limit_bytes')}) > ${s.threshold(0.9)}`,
    for: '10m',
    severity: 'warning',
    summary: "A process holds more of its container's memory limit than the threshold",
  }),
  rule({
    alert: 'UltimateTargetDown',
    expr: (s) => `count by (${s.by}, ${s.component}) (${s.series('up')} == 0) > 0`,
    for: '5m',
    severity: 'critical',
    summary: 'A role has a scrape target that is down',
  }),
];
