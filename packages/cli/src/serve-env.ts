// What a container's environment decides about a boot: which role, which port, which interface,
// and where errors are reported. Split from `serve.ts`, which re-exports every name here.

import type { Role } from '@ultimat3/core';
import { configureErrorReporting, isRole, ROLES, sentryErrorReporter } from '@ultimat3/core';
import { PortInvalidError, RoleUnknownError } from './errors';
import { DEFAULT_METRICS_PORT } from './metrics-endpoint';
import type { WebBinding } from './role-start';
import type { Env } from './runtime-bindings';

export const DEFAULT_PORT = 3000;

/**
 * Every interface, which is what a role binds when nothing says otherwise: a container bound to
 * loopback is unreachable through its own port mapping. `HOST` and `ServeOptions.hostname` are the
 * two ways of saying otherwise — see `hostnameFromEnv`.
 */
export const CONTAINER_BINDING: WebBinding = { dev: false, hostname: '0.0.0.0' };

/**
 * The interface the `web` and `sync` roles bind, and the metrics endpoint with them (`WebBinding`
 * is one decision). Read the way `PORT` is: empty or whitespace is the default.
 *
 * Exists because a container had exactly one binding, `0.0.0.0`, and an app whose auth mode is
 * "nobody logs in, one implicit actor" must refuse a public interface — so it could not run in a
 * container at all. `HOST=127.0.0.1` is unreachable through `docker run -p` (the proxy connects to
 * the container's bridge address, never its loopback); it is reachable where the container shares
 * the host's network namespace (`--network host`), or through a sidecar and `ssh -L` inside it —
 * which is the exposure such an app wants. Not `HOSTNAME`: Docker sets that to the container id.
 */
export function hostnameFromEnv(env: Env): string {
  const raw = env['HOST']?.trim();
  return raw === undefined || raw.length === 0 ? CONTAINER_BINDING.hostname : raw;
}

/** What `serveApp` hands `startRoles`: the caller's hostname, else `HOST`, else every interface. */
export const containerBinding = (env: Env, hostname?: string): WebBinding => ({
  dev: false,
  hostname: hostname ?? hostnameFromEnv(env),
});

/**
 * `ROLE` is the one knob one image exposes. Validated rather than defaulted: a typo that fell back
 * to `web` would start a process that serves nothing the operator asked for and reports healthy.
 */
export function roleFromEnv(env: Env): Role {
  const raw = env['ROLE'] ?? 'web';
  if (!isRole(raw)) throw new RoleUnknownError({ role: raw, known: ROLES });
  return raw;
}

/**
 * `Number.parseInt` would read `80abc` as 80, so the whole string has to be a port — a
 * partially-parsed port is a deploy that binds somewhere nobody asked for.
 */
function portValue(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new PortInvalidError({ value: raw, name });
  return port;
}

/** Every PaaS injects `PORT` and routes traffic to exactly it. */
export function portFromEnv(env: Env): number {
  return portValue(env, 'PORT', DEFAULT_PORT);
}

/**
 * The scrape port, deliberately its own env var and not `PORT + n`: an operator who moves the app
 * port must not silently move the port their Prometheus is configured against, and the roles that
 * set no `PORT` at all — `worker`, `scheduler`, `replicator` — still need this one.
 */
export function metricsPortFromEnv(env: Env): number {
  return portValue(env, 'METRICS_PORT', DEFAULT_METRICS_PORT);
}

/**
 * The scrape port a boot uses, given the app port it already resolved. One expression, and it is
 * exported because `x dev` is the second caller: `cmd-dev.ts` passed no `metricsPort` at all, so
 * `METRICS_PORT` was honoured in the container and ignored on a laptop — the dev/prod parity break
 * `role-start.ts`'s own header forbids, and a second copy of this rule would be the same break
 * one edit later.
 *
 * An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
 * fixed 9090 would fail the next suite to boot beside it. An environment that names the port still
 * wins — that is the deploy talking.
 */
export const metricsPortFor = (env: Env, port: number, override?: number): number =>
  override ?? (port === 0 && env['METRICS_PORT'] === undefined ? 0 : metricsPortFromEnv(env));

/**
 * The one env var that turns error monitoring on, and the only vendor-shaped name in the boot
 * path. Not a platform primitive (axiom 7): the value is a URL to whatever the operator runs, the
 * wire format behind it is documented and self-hostable, and `SENTRY_DSN` is what every monitor
 * that speaks it already documents — inventing a second spelling would mean an operator's existing
 * tooling sets a variable this framework ignores. Exactly the precedent
 * `OTEL_EXPORTER_OTLP_ENDPOINT` already sets in `docker/helm/values.yaml`.
 */
export const ERROR_DSN_KEY = 'SENTRY_DSN';

/**
 * Switch reporting on for this process. Unset DSN leaves core's no-op reporter in place, so a
 * laptop and a CI run pay nothing and page nobody — and the release every event carries is the
 * build id this boot already computed, never a second identity for the same deploy.
 */
export function configureReporting(env: Env, buildId: string): void {
  const dsn = env[ERROR_DSN_KEY]?.trim();
  configureErrorReporting({
    release: buildId,
    // A malformed DSN throws here, at boot, rather than at the first outage: a monitor that was
    // never connected looks exactly like an app that never failed.
    ...(dsn === undefined || dsn.length === 0 ? {} : { reporter: sentryErrorReporter({ dsn }) }),
  });
}
