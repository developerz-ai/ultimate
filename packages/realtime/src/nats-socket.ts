// Single responsibility: the one production `NatsStream`, over `Bun.connect` — plus the URL
// parsing. NATS sends its INFO line in cleartext before any TLS decision, so the upgrade is a
// method the caller invokes after reading it, never a handshake negotiated here at connect time.

import { TransportUnavailableError } from './errors';
import type { BunConnect, SocketHandlers, SocketLike } from './pg-socket';

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

const DEFAULT_PORT = 4222;

/** `nats://user:pass@host:4222`. The one place a bus URL is read. */
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
    throw new TransportUnavailableError({
      transport: 'nats',
      reason: `"${url}" has no host`,
    });
  }
  const hasUser = parsed.username !== '';
  const hasPass = parsed.password !== '';
  const user = hasUser ? decodeURIComponent(parsed.username) : undefined;
  const pass = hasPass ? decodeURIComponent(parsed.password) : undefined;
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? DEFAULT_PORT : Number.parseInt(parsed.port, 10),
    tls: parsed.protocol === 'tls:',
    // A username with no password is NATS' bare-token form; a password makes it user/pass instead.
    user: hasUser && hasPass ? user : undefined,
    pass: hasUser && hasPass ? pass : undefined,
    token: hasUser && !hasPass ? user : undefined,
  };
}

/** The byte pipe a NATS connection runs over. Mirrors `PgStream`, plus the late TLS upgrade. */
export interface NatsStream {
  /** The next chunk the server sent, or `undefined` once it closed the connection. */
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
  /** In-band TLS. Must be called before any byte other than the server's INFO is exchanged. */
  upgradeTls(): void;
  close(): void;
}

interface Waiter {
  readonly resolve: (chunk: Uint8Array | undefined) => void;
  readonly reject: (error: Error) => void;
}

/** Chunks the socket pushed, handed out one `read()` at a time — EOF and socket errors included. */
class ChunkQueue {
  readonly #chunks: Uint8Array[] = [];
  #waiting: Waiter | undefined;
  #ended = false;
  #failure: Error | undefined;

  push(chunk: Uint8Array): void {
    const waiter = this.#take();
    if (waiter === undefined) {
      this.#chunks.push(chunk);
      return;
    }
    waiter.resolve(chunk);
  }

  /** EOF. A reader parked on `read()` is released rather than left hanging forever. */
  end(): void {
    this.#ended = true;
    this.#take()?.resolve(undefined);
  }

  fail(error: Error): void {
    this.#failure = error;
    this.#ended = true;
    this.#take()?.reject(error);
  }

  read(): Promise<Uint8Array | undefined> {
    const next = this.#chunks.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  #take(): Waiter | undefined {
    const waiter = this.#waiting;
    this.#waiting = undefined;
    return waiter;
  }
}

export const bunNatsStream = (target: NatsTarget): Promise<NatsStream> =>
  natsStreamOver(Bun as unknown as BunConnect, target);

/** `bunNatsStream` with the runtime handed in, so the whole path runs in a test with no network. */
export async function natsStreamOver(runtime: BunConnect, target: NatsTarget): Promise<NatsStream> {
  const queue = new ChunkQueue();
  let draining: (() => void) | undefined;
  let upgraded = false;

  /**
   * A write parked for `drain` can never get one from a socket that is gone, so it is released
   * here; it then fails on the next `write` rather than burning a whole deadline first. The read
   * side ends cleanly because an EOF that matters is already an error one layer up.
   */
  const died = (): void => {
    const resume = draining;
    draining = undefined;
    resume?.();
    queue.end();
  };

  const handlers: SocketHandlers = {
    data: (_socket, data) => queue.push(data),
    close: died,
    end: died,
    drain: () => {
      const resume = draining;
      draining = undefined;
      resume?.();
    },
    error: (_socket, error) =>
      queue.fail(
        new TransportUnavailableError({
          transport: 'nats',
          reason: `${target.host}:${target.port} — ${error.message}`,
        }),
      ),
  };

  let socket: SocketLike = await runtime.connect({
    hostname: target.host,
    port: target.port,
    socket: handlers,
  });

  const write = async (bytes: Uint8Array): Promise<void> => {
    let rest = bytes;
    while (rest.length > 0) {
      const written = socket.write(rest);
      if (written >= rest.length) return;
      // A negative count is a refusal, not backpressure: no `drain` follows a dead socket, so
      // waiting for one would park this write forever.
      if (written < 0) {
        throw new TransportUnavailableError({
          transport: 'nats',
          reason: `the socket refused a ${rest.length}-byte write to ${target.host}:${target.port}`,
        });
      }
      if (written > 0) rest = rest.subarray(written);
      await new Promise<void>((resolve) => {
        draining = resolve;
      });
    }
  };

  return {
    read: () => queue.read(),
    write,
    upgradeTls: () => {
      // Marked before the attempt, not after: a failed upgrade still leaves the raw socket in an
      // indeterminate TLS-negotiation state, so a retry is refused rather than risking a second
      // ClientHello on top of the first.
      if (upgraded) {
        throw new TransportUnavailableError({
          transport: 'nats',
          reason: `upgradeTls() was already called for ${target.host}:${target.port}`,
        });
      }
      upgraded = true;
      // Bun hands back `[raw, tls]`; every later read and write goes through the second one, and
      // the handlers are re-registered because the upgraded socket is a different object.
      const next = socket.upgradeTLS({ tls: { serverName: target.host }, socket: handlers })[1];
      if (next === undefined) {
        throw new TransportUnavailableError({
          transport: 'nats',
          reason: `the runtime returned no TLS socket for the upgrade to ${target.host}:${target.port}`,
          fix: 'bun upgrade   # in-band TLS needs bun >= 1.3',
        });
      }
      socket = next;
    },
    close: () => socket.end(),
  };
}
