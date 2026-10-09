// Single responsibility: the scrape listener every role opens. `@ultimat3/core` declares the
// series and renders the body; this is the one place a process answers `METRICS_PATH` with it, so
// `docker/helm`'s HPAs read a number instead of `<unknown>`. Opening it starts the process's own
// series (`process_*`): a role that can be scraped reports what it costs.

import {
  BUILD_ID_HEADER,
  finiteCount,
  type HealthPayload,
  healthzPayload,
  logger,
  METRICS_CONTENT_TYPE,
  METRICS_PATH,
  markListening,
  metricsText,
  readyzPayload,
  startProcessMetrics,
  stringField,
  UltimateError,
} from '@ultimat3/core';
import { neighbouringPort } from './flag-number';
import { quoteArg } from './shell-quote';

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
      fix: `METRICS_PORT=${quoteArg(String(neighbouringPort(input.port)))} x dev --json`,
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
  /**
   * The `process_info{role}` label: `ROLE` in a container, the roles `x dev` runs joined by `+`.
   * A host that opens the listener itself and names none is labelled `unknown`.
   */
  readonly role?: string;
  /**
   * What a taken port means. `refuse` (the default, and every container's): `X_PORT_IN_USE` —
   * Prometheus is configured against the declared port, so listening anywhere else is a scrape
   * that silently finds nothing. `free`: bind whichever port the kernel hands out and say which —
   * `x dev` with no `METRICS_PORT`, where two apps on one laptop both default to 9090.
   */
  readonly whenTaken?: 'refuse' | 'free';
}

/**
 * Which answer a boot gives. A laptop that named no port takes a free one when 9090 is another
 * app's; a declared `METRICS_PORT` — and every container — is the port a scraper was told, so it
 * refuses rather than listen where nothing will look.
 */
export const whenMetricsPortTaken = (
  dev: boolean,
  env: Readonly<Record<string, string | undefined>>,
): 'refuse' | 'free' => {
  const declared = env['METRICS_PORT'];
  return dev && (declared === undefined || declared.trim().length === 0) ? 'free' : 'refuse';
};

/**
 * The bind and its one retry. `bind` is `Bun.serve` behind a seam: whether a kernel refuses a
 * second bind is the OS's answer, and the rule here is testable without racing a socket for it.
 * Port 0 is never retried — the kernel chose it, so a refusal there is not a collision.
 */
export function bindScrapePort<T>(
  port: number,
  whenTaken: 'refuse' | 'free',
  bind: (port: number) => T,
): T {
  try {
    return bind(port);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    if (whenTaken === 'refuse' || port === 0) throw new MetricsPortInUseError({ port });
    logger.warn('ultimate metrics port taken', {
      port,
      cause: `the metrics port ${String(port)} is already bound — another x dev, or a Prometheus — so this process listens on a free one`,
      fix: `METRICS_PORT=${quoteArg(String(neighbouringPort(port)))} x dev --json`,
    });
    return bind(0);
  }
}

export interface MetricsEndpoint {
  /** `http://host:port` — the base the scrape target appends `METRICS_PATH` to. */
  readonly url: string;
  /**
   * The build this process serves, sent as `x-ultimate-build` on `/healthz` and `/readyz` from here
   * on — as every page sends it (#734). Told rather than passed at open: a container opens this
   * port BEFORE its boot computes the build id (`serve.ts`), and `startRoles` is the one caller
   * that has it, whichever opened the port. Until then the health answers carry no header.
   */
  announceBuild(buildId: string): void;
  stop(): void;
}

/**
 * `/healthz` and `/readyz` for the roles whose only socket this is — `worker`, `scheduler`,
 * `replicator` — so the replicator's readiness check (`role-replicator.ts`) is read by a probe.
 * The verdict only, never the report: this port is unauthenticated, and check names are topology.
 */
function healthResponse(payload: HealthPayload, role: string, buildId: string | null): Response {
  return Response.json(
    { state: payload.body.state, ready: payload.body.ready, role },
    {
      status: payload.status,
      // The build in the header (public on every page), never in the body (#53, #734).
      headers: {
        'cache-control': 'no-store',
        ...(buildId === null ? {} : { [BUILD_ID_HEADER]: buildId }),
      },
    },
  );
}

/**
 * Answers outside the request pipeline, exactly as `/healthz` and `/readyz` do in
 * `@ultimat3/http`'s `server.ts`: no auth, no rate limit, no locale negotiation. A saturated or
 * draining process must still be able to say how saturated it is — an autoscaler that loses its
 * signal at the moment of load is worse than no autoscaler.
 */
export function startMetricsEndpoint(options: MetricsEndpointOptions = {}): MetricsEndpoint {
  // Screened here rather than left to `Bun.serve`, which refuses a `NaN` with a bare `RangeError`
  // — no code, no `fix:` — at exactly the boot path the refusal below exists to stop reporting
  // that way. Floor 0, because 0 asks the kernel for a free port and `role-start.ts` passes it for
  // an ephemeral boot; the ceiling stays Bun's, which names the range it refuses.
  const port = finiteCount('startMetricsEndpoint', 'port', options.port ?? DEFAULT_METRICS_PORT);
  let buildId: string | null = null;
  // `startRoles` opens this FIRST, before any role, so `Bun.serve`'s own bare `Error` was what a
  // second `x dev` on one machine reported: no code, no fix, at the boot path this package owns.
  const server = bindScrapePort(port, options.whenTaken ?? 'refuse', (candidate) =>
    Bun.serve({
      port: candidate,
      hostname: options.hostname ?? 'localhost',
      fetch(request: Request): Response {
        const url = new URL(request.url);
        const role = options.role ?? 'unknown';
        if (url.pathname === '/healthz') return healthResponse(healthzPayload(), role, buildId);
        if (url.pathname === '/readyz') {
          return healthResponse(
            readyzPayload({ deep: url.searchParams.get('deep') === '1' }),
            role,
            buildId,
          );
        }
        if (url.pathname !== METRICS_PATH) {
          return new Response('not found', { status: 404 });
        }
        // `collectMetrics()` is cumulative and never reset by a read, so two scrapers cannot
        // steal each other's samples — but a cache would hand the second one a stale window.
        return new Response(metricsText(), {
          headers: { 'content-type': METRICS_CONTENT_TYPE, 'cache-control': 'no-store' },
        });
      },
    }),
  );
  // After the bind: a port that was taken starts no sampler nobody would stop.
  const stopProcessMetrics = startProcessMetrics({ role: options.role ?? 'unknown' });
  // Same rule as every other socket the framework opens: announce it, so a request back to it is
  // recognisably this process calling itself rather than egress the test seal must refuse.
  const stopListening = markListening(server.url.origin);
  logger.info('ultimate metrics listening', { url: `${server.url.origin}${METRICS_PATH}` });
  return {
    url: server.url.origin,
    announceBuild(id: string): void {
      buildId = id;
    },
    stop(): void {
      server.stop(true);
      stopListening();
      stopProcessMetrics();
    },
  };
}
