// Single responsibility: how long a dial is waited for — one attempt's connect timeout, and the
// bounded wait a process that cannot work without the bus puts on the whole retry loop.

import { finiteOption } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';

/**
 * One dial's connect timeout. Well under `BUS_CONNECT_WAIT_MS`: a black-holed server must fail
 * several attempts inside a `sync` node's boot wait, so its refusal carries the attempt's own
 * reason rather than an empty one, and a background dial keeps its backoff instead of the
 * library's 20 s.
 */
export const DIAL_TIMEOUT_MS = 4_000;

export interface NatsConnectWait {
  /** Refuse with `X_TRANSPORT_UNAVAILABLE` once this long has passed without a connection. */
  readonly withinMs?: number | undefined;
  /** The `fix:` of that refusal — the caller knows which role is waiting and what it needs. */
  readonly fix?: string | undefined;
}

export interface DialWait {
  readonly transport: string;
  /** `host:port`, never the url: the url carries the credential. */
  readonly server: string;
  readonly withinMs: number;
  readonly fix: string | undefined;
  /** The last attempt's own refusal, read when the wait runs out. */
  readonly lastFailure: () => string | undefined;
}

/**
 * `landing`, or a coded refusal once `withinMs` has passed. A real timer, never an injected clock:
 * the wait bounds a container's boot, which the kubelet counts in real seconds. The loser is not
 * cancelled — a dial cannot be — so the caller's `close()` is what ends it.
 */
export async function landWithin(
  landing: Promise<void> | undefined,
  wait: DialWait,
): Promise<void> {
  const withinMs = finiteOption('createNatsTransport', 'connect.withinMs', wait.withinMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const failure = wait.lastFailure();
      const last = failure === undefined ? '' : ` — last attempt: ${failure}`;
      reject(
        new TransportUnavailableError({
          transport: wait.transport,
          reason: `${wait.server} did not accept a connection within ${withinMs}ms${last}`,
          ...(wait.fix === undefined ? {} : { fix: wait.fix }),
        }),
      );
    }, withinMs);
  });
  try {
    await Promise.race([landing, late]);
  } finally {
    clearTimeout(timer);
  }
}
