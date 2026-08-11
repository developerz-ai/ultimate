// Single responsibility: the scrape listener every role opens. `@ultimat3/core` declares the
// series and renders the body; this is the one place a process answers `METRICS_PATH` with it, so
// `docker/helm`'s HPAs read a number instead of `<unknown>`.

import {
  logger,
  METRICS_CONTENT_TYPE,
  METRICS_PATH,
  markListening,
  metricsText,
} from '@ultimat3/core';

/**
 * A port of its own, and NOT the role's HTTP port, for one reason the chart makes concrete:
 * `docker/helm/templates/ingress.yaml` routes `path: /` `Prefix` to the web Service, so a
 * `/metrics` mounted beside `/healthz` on port 3000 is `/metrics` on the internet — route
 * patterns, request volumes and error rates, published. Nothing in the chart fronts this port:
 * `service.yaml` only publishes `http`, so the endpoint is cluster-internal by construction
 * rather than by an ingress exclusion somebody has to remember to write.
 *
 * It is also the only thing `worker`, `scheduler` and `replicator` could ever be scraped on —
 * they open no HTTP socket at all, and `queue_depth` is exactly the signal one of them owns.
 * 9090 is Prometheus's own convention, so a scrape config that assumes it needs no edit.
 */
export const DEFAULT_METRICS_PORT = 9090;

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
  const server = Bun.serve({
    port: options.port ?? DEFAULT_METRICS_PORT,
    hostname: options.hostname ?? 'localhost',
    fetch(request: Request): Response {
      if (new URL(request.url).pathname !== METRICS_PATH) {
        return new Response('not found', { status: 404 });
      }
      // `collectMetrics()` is cumulative and never reset by a read, so two scrapers cannot steal
      // each other's samples — but a cache would hand the second one a stale window.
      return new Response(metricsText(), {
        headers: { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' },
      });
    },
  });
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
