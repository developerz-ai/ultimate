// The web or sync role's own port while it boots: `/healthz` from the process's liveness, `/readyz`
// 503, every other path 503 — so the pod's startup and liveness probes, which knock on THIS port,
// see a live pod that is not ready while it waits for the migrate step, never a closed socket that
// restarts it at the startup probe's budget. `bootRoles` stops it just before the role binds.

import type { HealthPayload, Role } from '@ultimat3/core';
import { markListening, readyzPayload, stringField } from '@ultimat3/core';
import { rolePorts } from './metrics-endpoint';
import { livenessPayload } from './runtime-liveness';
import {
  type ListenerTls,
  ListenerTlsInvalidError,
  TLS_CERT_ENV,
  TLS_KEY_ENV,
} from './serve-env-tls';

export interface BootProbe {
  /** Idempotent, and synchronous: the port is free for the role's listener when this returns. */
  stop(): void;
}

export interface BootProbeInput {
  readonly role: Role;
  /** The app port; the sync role's listener is on `PORT + 1` (`rolePorts`). `0` opens none. */
  readonly port: number;
  readonly hostname: string;
  readonly tls?: ListenerTls;
}

/** Seconds a client is told to come back after, while the pod boots. */
const RETRY_AFTER_S = '5';

function answer(payload: HealthPayload, role: Role): Response {
  return Response.json(
    { state: payload.body.state, ready: payload.body.ready, role },
    { status: payload.status, headers: { 'cache-control': 'no-store' } },
  );
}

/** OpenSSL's code alone: its message can quote the input, and the input can be a private key. */
const OPENSSL_CODE = /^ERR_OSSL_[A-Z0-9_]+$/;

/**
 * The FIRST place `TLS_CERT` / `TLS_KEY` reach OpenSSL, before `defineHttpConfig` judges them, so
 * a pair it refuses is `X_CONFIG_INVALID` here (both variables and the code, never the bytes)
 * rather than a bare `ERR_OSSL_*` with no fix. Any other failure (a taken port) is the bind's own.
 */
function servedWithTls<T>(serve: () => T): T {
  try {
    return serve();
  } catch (error) {
    const code = stringField(error, 'code');
    if (code === undefined || !OPENSSL_CODE.test(code)) throw error;
    throw new ListenerTlsInvalidError({
      name: `${TLS_CERT_ENV} or ${TLS_KEY_ENV}`,
      reason: `was refused by OpenSSL (${code}): the pair must be a PEM certificate and its own PEM private key`,
    });
  }
}

/**
 * `undefined` for the roles whose probes knock on the metrics port — open before any boot work
 * (`serve.ts`) — and for an ephemeral boot (a test), whose real port is not known yet.
 */
export function openBootProbe(input: BootProbeInput): BootProbe | undefined {
  const port = rolePorts(input.port, [input.role])[0]?.port;
  if (port === undefined) return undefined;
  const { role } = input;
  const serve = () =>
    Bun.serve({
      port,
      hostname: input.hostname,
      ...(input.tls === undefined ? {} : { tls: { cert: input.tls.cert, key: input.tls.key } }),
      fetch(request: Request): Response {
        const path = new URL(request.url).pathname;
        if (path === '/healthz') return answer(livenessPayload(), role);
        if (path === '/readyz') return answer(readyzPayload(), role);
        // Not served from a half-booted process: a request that reached a pod no probe called ready
        // is told to come back, never answered by a schema it cannot read yet.
        return Response.json(
          { state: 'starting', ready: false, role },
          { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': RETRY_AFTER_S } },
        );
      },
    });
  const server = input.tls === undefined ? serve() : servedWithTls(serve);
  const stopListening = markListening(server.url.origin);
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      server.stop(true);
      stopListening();
    },
  };
}
