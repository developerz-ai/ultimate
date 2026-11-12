// Single responsibility: the metrics EVERY Ultimate process emits, named to match what the
// deploy chart already scales on. One place decides these names — `roles.ts` says what a role
// scales on, this says which series carries it, and `docker/helm` reads the same three words.

import type { Counter, Gauge } from './metrics';
import { counter, DEFAULT_MAX_SERIES, gauge, type Histogram, histogram } from './metrics';
import type { ScalingSignal } from './roles';

/**
 * The instrument behind each role's scaling signal.
 *
 * `rps` is a RATE, and a rate is derived, never stored: the process emits a monotonic counter and
 * the adapter differentiates it (`rate(http_requests_total[1m])`), which is also what the chart's
 * own comment ("via the ingress metric adapter") already assumes. The other two are instantaneous
 * values a scrape can read directly, so their series names are the chart's words verbatim.
 */
export const SCALING_METRICS = Object.freeze<Record<ScalingSignal, string | null>>({
  rps: 'http_requests_total',
  'ws-connections': 'connections',
  // Not `queue_depth`, the backlog: ready-only, it reads 0 while a fleet holds every job it has, and
  // the HPA shrinks the fleet mid-job. `queue_demand` is held plus due (`@ultimat3/jobs`'s gauge).
  'queue-demand': 'queue_demand',
  singleton: null,
  'run-once': null,
  'per-database': null,
});

export const requests: Counter = counter('http_requests_total', {
  unit: '{request}',
  description: 'HTTP requests served, by route, method and status class',
});

export const requestDuration: Histogram = histogram('http_request_duration_seconds', {
  unit: 's',
  description: 'HTTP server request duration',
});

export const connections: Gauge = gauge('connections', {
  unit: '{connection}',
  description: 'Live websocket connections held by this process',
});

export const queueDepth: Gauge = gauge('queue_depth', {
  unit: '{job}',
  description: 'Jobs waiting to be picked up, by queue',
});

export const jobs: Counter = counter('jobs_total', {
  unit: '{job}',
  description: 'Background jobs finished, by queue and outcome',
});

export const leasesLost: Counter = counter('job_leases_lost_total', {
  unit: '{job}',
  description: 'Job leases that lapsed while the job was still running, by queue',
});

export interface RequestSample {
  readonly method: string;
  /** The route PATTERN (`/posts/:id`), never the concrete path — one series per pattern. */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
}

/**
 * One call per served request, from the HTTP pipeline. `status` becomes a status CLASS (`2xx`)
 * because a label per status code multiplies every series by the number of codes an app can
 * return, and no autoscaler asks the difference between 201 and 204.
 */
export function recordRequest(sample: RequestSample): void {
  const attributes = requestAttributes(
    sample.method,
    sample.route,
    Math.floor(sample.status / 100),
  );
  requests.add(1, attributes);
  requestDuration.record(sample.durationMs / 1000, attributes);
}

type RequestAttributes = Readonly<{ method: string; route: string; status: string }>;

/**
 * One FROZEN label set per (method, route, class), so the series key behind it is built once for
 * the process (`metric-series.ts` keys a frozen set by identity) instead of twice per request.
 * Nested maps, never a joined string key: a delimiter is spellable by a value. Bounded at the
 * instrument's own ceiling; past it a fresh frozen set still shares its one key across both
 * instruments, and the series store's overflow handles the cardinality.
 */
const requestLabels = new Map<string, Map<string, Map<number, RequestAttributes>>>();
let requestLabelCount = 0;

function requestAttributes(method: string, route: string, statusClass: number): RequestAttributes {
  const byRoute = requestLabels.get(method);
  const cached = byRoute?.get(route)?.get(statusClass);
  if (cached !== undefined) return cached;
  const built = Object.freeze({ method, route, status: `${statusClass}xx` });
  if (requestLabelCount >= DEFAULT_MAX_SERIES) return built;
  const routes = byRoute ?? new Map<string, Map<number, RequestAttributes>>();
  requestLabels.set(method, routes);
  const classes = routes.get(route) ?? new Map<number, RequestAttributes>();
  routes.set(route, classes);
  classes.set(statusClass, built);
  requestLabelCount += 1;
  return built;
}

/** `+1` on connect, `-1` on close, from the realtime transport. */
export function recordConnection(delta: number): void {
  connections.add(delta);
}

/** Absolute depth, from the worker's own queue read. */
export function recordQueueDepth(queue: string, depth: number): void {
  queueDepth.record(depth, { queue });
}

export function recordJob(queue: string, outcome: 'ok' | 'failed' | 'dead'): void {
  jobs.add(1, { queue, outcome });
}

/**
 * One per job whose lease the holding process could not renew inside the visibility timeout.
 * Deliberately not an outcome on `jobs_total`: nothing failed and nothing finished — the queue
 * simply handed the job to somebody else while this process was still running it. Every point on
 * this series is one job that ran twice, which is the only reason it is worth a series at all.
 */
export function recordLeaseLost(queue: string): void {
  leasesLost.add(1, { queue });
}

export const breakerTransitions: Counter = counter('breaker_transitions_total', {
  unit: '{transition}',
  description: 'Circuit breaker state changes, by breaker name and the state entered',
});

/**
 * One per state change of a `breaker()`, called only by `breaker.ts`. `name` is a label the app
 * chose in code (bounded), never a tenant or a URL, so the series count is the breaker count × 3.
 */
export function recordBreakerTransition(name: string, to: 'closed' | 'open' | 'half-open'): void {
  breakerTransitions.add(1, { name, to });
}
