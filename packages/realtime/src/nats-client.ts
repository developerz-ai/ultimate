// Single responsibility: the bus port — the narrow NATS surface this package uses, and the URL that
// names a server. Everything above this file is written against the port, so framing, the parser,
// PING/PONG, the TLS upgrade and the reconnect belong to whoever implements it: `nats` in
// production (`nats-lib-client.ts`), an in-memory bus in a test (`nats-fake.ts`).

import { TransportUnavailableError } from './errors';

export type NatsHeaders = ReadonlyMap<string, string>;

export interface NatsMessage {
  readonly subject: string;
  readonly payload: Uint8Array;
  /** `0` unless the reply carried a status: a direct read answers `404`, a batch ends on `204`. */
  readonly status: number;
  /** Case-insensitive — the server spells `Nats-Subject` and the caller asks however it likes. */
  header(name: string): string | undefined;
}

export interface NatsSubscription {
  unsubscribe(): void;
}

export type NatsMessageHandler = (message: NatsMessage) => void;

export interface NatsRequestOptions {
  readonly headers?: NatsHeaders | undefined;
}

export interface NatsRequestManyOptions {
  /** Collection stops at the first message this accepts, and that message is not collected. */
  readonly until: (message: NatsMessage) => boolean;
}

/**
 * What the bus needs from a NATS connection, and nothing more. A subscription outlives a reconnect —
 * the client re-establishes it underneath the caller — which is why nothing above this port keeps
 * subscription bookkeeping of its own.
 */
export interface NatsClient {
  /** The connected server's version, as `assertServerVersion` reads it. */
  readonly version: string;
  /** False while a reconnect is in flight, and forever once `close()` has run. */
  readonly connected: boolean;
  publish(subject: string, payload: Uint8Array): void;
  subscribe(subject: string, handler: NatsMessageHandler): NatsSubscription;
  request(subject: string, payload: Uint8Array, options?: NatsRequestOptions): Promise<NatsMessage>;
  requestMany(
    subject: string,
    payload: Uint8Array,
    options: NatsRequestManyOptions,
  ): Promise<readonly NatsMessage[]>;
  close(): Promise<void>;
}

export interface NatsTarget {
  readonly host: string;
  readonly port: number; // default 4222
  /** `tls://` demands TLS; `nats://` still upgrades when the server's INFO says it is required. */
  readonly tls: boolean;
  readonly user: string | undefined;
  readonly pass: string | undefined;
  /** `nats://token@host` — NATS' single-credential form, mutually exclusive with user/pass. */
  readonly token: string | undefined;
}

export interface NatsClientOptions {
  readonly url: string;
  /** Shows up in `nats server report connections`, so an operator can name the process. */
  readonly name?: string | undefined;
  readonly maxReconnectAttempts?: number | undefined;
  /** Our jitter policy, asked once per attempt — the herd is ours to spread, not the library's. */
  readonly reconnectDelay?: (() => number) | undefined;
  readonly requestTimeoutMs?: number | undefined;
  /** A background failure: a dropped connection, a server error, an exhausted reconnect. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** The library re-established the connection. The cluster behind it may be a different one. */
  readonly onReconnect?: (() => void) | undefined;
}

/** The one seam a test replaces: a client that never touches a socket. */
export type NatsConnect = (options: NatsClientOptions) => Promise<NatsClient>;

export const DEFAULT_NATS_PORT = 4222;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * `nats://user:pass@host:4222`. The one place a bus URL is read — the library takes a bare
 * `host:port` plus credentials as options, and never looks at a URL's userinfo.
 */
export function parseNatsUrl(url: string): NatsTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportUnavailableError({
      transport: 'nats',
      reason: `"${url}" is not a connection URL`,
    });
  }
  if (parsed.protocol !== 'nats:' && parsed.protocol !== 'tls:') {
    throw new TransportUnavailableError({
      transport: 'nats',
      reason: `the connection URL uses "${parsed.protocol}" rather than nats: or tls:`,
    });
  }
  if (parsed.hostname === '') {
    throw new TransportUnavailableError({ transport: 'nats', reason: `"${url}" has no host` });
  }
  const hasUser = parsed.username !== '';
  const hasPass = parsed.password !== '';
  // A password with no user matches neither credential form, and dropping it silently connects
  // anonymously — the failure then surfaces as the server's own 'Authorization Violation', which
  // names nothing about the URL. The URL itself is never echoed back: it holds the secret.
  if (!hasUser && hasPass) {
    throw new TransportUnavailableError({
      transport: 'nats',
      reason: `the connection URL for ${parsed.hostname} carries a password with no user`,
      fix: 'set the URL to nats://<user>:<pass>@host:4222, or the bare-token form nats://<token>@host:4222',
    });
  }
  const user = hasUser ? decodeURIComponent(parsed.username) : undefined;
  const pass = hasPass ? decodeURIComponent(parsed.password) : undefined;
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? DEFAULT_NATS_PORT : Number.parseInt(parsed.port, 10),
    tls: parsed.protocol === 'tls:',
    // A username with no password is NATS' bare-token form; a password makes it user/pass instead.
    user: hasUser && hasPass ? user : undefined,
    pass: hasUser && hasPass ? pass : undefined,
    token: hasUser && !hasPass ? user : undefined,
  };
}
