// Single responsibility: the metrics EVERY Ultimate process emits, named to match what the
// deploy chart already scales on. One place decides these names — `roles.ts` says what a role
// scales on, this says which series carries it, and `docker/helm` reads the same three words.

import type { Counter, Gauge } from './metrics';
import { counter, gauge, type Histogram, histogram } from './metrics';
import type { ScalingSignal } from './roles';

/**
 * The instrument behind each role's scaling signal.
 *
 * `rps` is a RATE, and a rate is derived, never stored: the process emits a monotonic counter and
 * the adapter differentiates it (`rate(http_requests_total[1m])`), which is also what the chart's
 * own comment ("via the ingress metric adapter") already assumes. The other two are instantaneous
 * values a scrape can read directly, so their series names are the chart's words verbatim.
 */
export const SCALING_METRICS: Readonly<Record<ScalingSignal, string | null>> = Object.freeze({
  rps: 'http_requests_total',
  'ws-connections': 'connections',
  'queue-depth': 'queue_depth',
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
  const attributes = {
    method: sample.method,
    route: sample.route,
    status: `${Math.floor(sample.status / 100)}xx`,
  };
  requests.add(1, attributes);
  requestDuration.record(sample.durationMs / 1000, attributes);
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
