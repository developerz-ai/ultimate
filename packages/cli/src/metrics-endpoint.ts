// Single responsibility: the scrape listener every role opens. `@ultimat3/core` declares the
// series and renders the body; this is the one place a process answers `METRICS_PATH` with it, so
// `docker/helm`'s HPAs read a number instead of `<unknown>`.

import {
  logger,
  METRICS_CONTENT_TYPE,
  METRICS_PATH,
  markListening,
  metricsText,
  stringField,
  UltimateError,
} from '@ultimat3/core';
import { docsFor } from './error-codes';
import { neighbouringPort } from './flag-number';

/**
 * A port of its own, and NOT the role's HTTP port, for one reason the chart makes concrete:
 * `docker/helm/templates/ingress.yaml` routes `path: /` `Prefix` to the web Service, so a
 * `/metrics` mounted beside `/healthz` on port 3000 is `/metrics` on the internet — route
 * patterns, request volumes and error rates, published. `service.yaml` does publish this port
 * so a `ServiceMonitor` has a named target, but `ingress.yaml` selects its backend port BY NAME
 * (`http`), so the endpoint stays cluster-internal by construction rather than by an ingress
 * exclusion somebody has to remember to write.
 *
 * It is also the only thing `worker`, `scheduler` and `replicator` could ever be scraped on —
 * they open no HTTP socket at all, and `queue_depth` is exactly the signal one of them owns.
 * 9090 is Prometheus's own convention, so a scrape config that assumes it needs no edit.
 */
export const DEFAULT_METRICS_PORT = 9090;

/**
 * `X_PORT_IN_USE` is the code the CLI already registers for "this dev port is taken", and the
 * scrape port is one — a synonym here would be a second code for one condition. The fix moves the
 * port rather than naming a process to kill, because `METRICS_PORT` is the one knob both `x dev`
 * and the container read (`serve.ts`'s `metricsPortFromEnv`).
 *
 * The port it names comes from `neighbouringPort`, never `port + 1`: at the top of the range
 * that is 65536, and an instruction that cannot run is the failure this code exists to end.
 */
export class MetricsPortInUseError extends UltimateError {
  constructor(input: { port: number }) {
    super({
      code: 'X_PORT_IN_USE',
      cause: `the metrics port ${input.port} is already bound, so no role could open its scrape listener`,
      fix: `METRICS_PORT=${neighbouringPort(input.port)} x dev --json`,
      docs: docsFor('X_PORT_IN_USE'),
    });
  }
}

/**
 * Bun surfaces the bind failure as an `Error` carrying the libc code; nothing else is ours. Read
 * through `stringField`, never `error instanceof Error` plus a property access: both run on a value
 * this process did not build, and either can throw one line before the guard that was meant to make
 * the path safe. Exported because whether the kernel refuses a second bind is the OS's business,
 * not this package's — the contract worth pinning is that an EADDRINUSE-shaped throw becomes a
 * coded refusal, and that is testable without racing a socket.
 */
export const isAddressInUse = (error: unknown): boolean =>
  stringField(error, 'code') === 'EADDRINUSE';

export interface MetricsEndpointOptions {
  /** 0 asks the kernel for an ephemeral port, which is what a test wants. */
  readonly port?: number;
  /** A container must bind every interface; a laptop must not. Same decision as the web role. */
  readonly hostname?: string;
}

export interface MetricsEndpoint {
  /** `http://host:port` — the base the scrape target appends `METRICS_PATH` to. */
  readonly url: string;
  stop(): void;
}

/**
 * Answers outside the request pipeline, exactly as `/healthz` and `/readyz` do in
 * `@ultimat3/http`'s `server.ts`: no auth, no rate limit, no locale negotiation. A saturated or
 * draining process must still be able to say how saturated it is — an autoscaler that loses its
 * signal at the moment of load is worse than no autoscaler.
 */
export function startMetricsEndpoint(options: MetricsEndpointOptions = {}): MetricsEndpoint {
  const port = options.port ?? DEFAULT_METRICS_PORT;
  // `startRoles` opens this FIRST, before any role, so `Bun.serve`'s own bare `Error` was what a
  // second `x dev` on one machine reported: no code, no fix, at the boot path this package owns.
  // The return type is inferred, keeping `Bun.serve`'s own shape stated once.
  function listen() {
    try {
      return Bun.serve({
        port,
        hostname: options.hostname ?? 'localhost',
        fetch(request: Request): Response {
          if (new URL(request.url).pathname !== METRICS_PATH) {
            return new Response('not found', { status: 404 });
          }
          // `collectMetrics()` is cumulative and never reset by a read, so two scrapers cannot
          // steal each other's samples — but a cache would hand the second one a stale window.
          return new Response(metricsText(), {
            headers: { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' },
          });
        },
      });
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      throw new MetricsPortInUseError({ port });
    }
  }
  const server = listen();
  // Same rule as every other socket the framework opens: announce it, so a request back to it is
  // recognisably this process calling itself rather than egress the test seal must refuse.
  const stopListening = markListening(server.url.origin);
  logger.info('ultimate metrics listening', { url: `${server.url.origin}${METRICS_PATH}` });
  return {
    url: server.url.origin,
    stop(): void {
      server.stop(true);
      stopListening();
    },
  };
}
