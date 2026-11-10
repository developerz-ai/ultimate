// Single responsibility: which replicator failures are the CONNECTION going away — a server shut
// down or restarting, a reset socket, a lock session that died — and the short curve they redial
// on. Measured on the demo: a database restart cost ~73 s of frozen live windows, because every
// refused redial while the server was down grew the takeover backoff toward its 30 s cap.

import { renderThrowable } from '@ultimat3/core';
import { type BackoffPolicy, policyDelay } from './thundering-herd';

/** The longest the replicator waits between two redials while the connection is what failed. */
export const REPLICATOR_RECONNECT_MAX_MS = 2_000;

/**
 * The redial curve after a lost connection: the FIRST redial is immediate (`replicator.ts`), the
 * rest climb from 250 ms to two seconds. `equal` jitter keeps a floor, so a server still starting
 * is not asked again at once; there is one replicator per database, so there is no herd to spread.
 */
export const reconnectBackoff: BackoffPolicy = {
  baseMs: 250,
  maxMs: REPLICATOR_RECONNECT_MAX_MS,
  factor: 2,
  jitter: 'equal',
};

/** What a socket error carries in `code` (Bun's `connect` rejects with `{ code: 'ECONNREFUSED' }`). */
const SOCKET_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

/**
 * In the rendered failure: an admin, crash or startup shutdown (SQLSTATE 57P01/57P02/57P03, as
 * `describeFields` leads with it), a socket code in a message, and the phrases this package's own
 * Postgres client says when the far end went away — the dial found no listener
 * (`pg-socket.ts`'s `connectFailure`), a write the dead socket refused, an idle session closed, and
 * any lost advisory-lock session (it is lost only when its connection ends).
 */
const CONNECTION_TEXT =
  /(?<![\w/])(?:57P0[123]|ECONNRESET|ECONNREFUSED|EPIPE)\b|postgres replication (?:connect|write) failed|the server closed the connection|the advisory lock was lost/;

/**
 * `true` when `failure` — a stream's end reason or what a restart threw — is the connection ending
 * underneath the replicator rather than something a redial cannot fix (a refused publish, a
 * privilege, a decode the package does not speak). Those keep the long curve; this one redials.
 */
export function connectionLost(failure: unknown): boolean {
  if (typeof failure === 'object' && failure !== null && 'code' in failure) {
    const { code } = failure;
    if (typeof code === 'string' && SOCKET_CODES.has(code)) return true;
  }
  const text = typeof failure === 'string' ? failure : renderThrowable(failure);
  return CONNECTION_TEXT.test(text);
}

/**
 * The takeover loop's two curves and their counts. `long` is the replicator's own `retryDelayMs`
 * (a refused change, a standby, a stream that ended politely); a lost connection redials at once,
 * then on `reconnectBackoff`. Both counts reset only on a PUBLISHED change — "a stream came up" is
 * not progress, so a server that kills every new stream cannot hold the loop at zero.
 */
export class RedialCurve {
  readonly #long: (attempt: number) => number;
  readonly #rng: () => number;
  #attempt = 0;
  #reconnects = 0;

  constructor(long: (attempt: number) => number, rng: () => number) {
    this.#long = long;
    this.#rng = rng;
  }

  /** The wait before the next redial, counted. */
  next(lost: boolean): number {
    if (!lost) {
      const wait = this.#long(this.#attempt);
      this.#attempt += 1;
      return wait;
    }
    const count = this.#reconnects;
    this.#reconnects += 1;
    return count === 0 ? 0 : policyDelay(reconnectBackoff, count, this.#rng);
  }

  /** A change went out: the next death is a first one again, on either curve. */
  progress(): void {
    this.#attempt = 0;
    this.#reconnects = 0;
  }
}
