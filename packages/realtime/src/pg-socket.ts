// Single responsibility: the one production `PgStream`, over `Bun.connect` — plus the URL parsing
// and the SSLRequest handshake that has to happen before the first protocol byte. Bun pushes bytes
// at handlers while the connection pulls messages, so a queue sits between them.

import { renderThrowable } from '@ultimat3/core';
import { ReplicationFailedError, ReplicationProtocolError, ReplicationTlsError } from './errors';
import { judgeHandshake, parseSsl, rootCertificate, type SslMode } from './pg-tls';
import { type PgStream, sslRequest } from './pg-wire';

export type { SslMode } from './pg-tls';

/** Structural view of Bun's socket, declared here so the contract does not need bun-types. */
export interface SocketLike {
  write(data: Uint8Array): number;
  end(): void;
  upgradeTLS(options: {
    readonly tls: {
      readonly serverName: string;
      readonly rejectUnauthorized: boolean;
      readonly ca?: string;
    };
    readonly socket: SocketHandlers;
  }): readonly SocketLike[];
}

export interface SocketHandlers {
  data(socket: SocketLike, data: Uint8Array): void;
  close(): void;
  end(): void;
  drain(): void;
  error(socket: SocketLike, error: Error): void;
  /** TLS sockets only: Bun reports the verification it did instead of acting on it. */
  handshake?(socket: SocketLike, success: boolean, authorizationError: Error | null): void;
}

export interface BunConnect {
  connect(options: {
    readonly hostname: string;
    readonly port: number;
    readonly socket: SocketHandlers;
  }): Promise<SocketLike>;
}

export interface PgTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string | undefined;
  readonly ssl: SslMode;
  /** `sslrootcert`: a PEM path, `'system'`, or absent for the runtime's trust store. */
  readonly rootCert?: string | undefined;
}

/** `postgres://user:pass@host:5432/db?sslmode=require`. The one place a connection URL is read. */
export function parsePgUrl(url: string): PgTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The variable, never its value: a connection URL carries the database password, and an
    // error is the one thing that reaches a log, `--json`, an agent transcript and a ticket.
    // Same rule as `packages/mail/src/driver-smtp.ts:68`.
    throw new ReplicationFailedError({
      stage: 'connect',
      detail: 'DATABASE_URL is not a connection URL',
      fix: 'set DATABASE_URL to postgres://user:password@host:5432/database',
    });
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ReplicationFailedError({
      stage: 'connect',
      detail: `the connection URL uses "${parsed.protocol}" rather than postgres:`,
      fix: 'set DATABASE_URL to postgres://user:password@host:5432/database',
    });
  }
  const { ssl, rootCert } = parseSsl(parsed.searchParams);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 5432 : Number.parseInt(parsed.port, 10),
    database: database === '' ? 'postgres' : database,
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: parsed.password === '' ? undefined : decodeURIComponent(parsed.password),
    ssl,
    rootCert,
  };
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
    // One slot, one waiter: overwriting it would abandon the first promise unsettled forever, so
    // the single-consumer rule is refused here rather than written down and hoped for.
    if (this.#waiting !== undefined) {
      return Promise.reject(
        new ReplicationProtocolError({
          stage: 'read',
          detail: 'a second read() arrived while one was already parked on this stream',
          fix: 'read this stream from one place only — PgConnection owns it for the whole session',
        }),
      );
    }
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

export const bunPgStream = (target: PgTarget): Promise<PgStream> =>
  pgStreamOver(Bun as unknown as BunConnect, target);

/**
 * `bunPgStream` with the runtime handed in. TLS is negotiated in-band: postgres answers the
 * 8-byte SSLRequest with a single `S` or `N` **before** any framed message exists, so it has to
 * happen here rather than in the message layer.
 */
export async function pgStreamOver(runtime: BunConnect, target: PgTarget): Promise<PgStream> {
  const queue = new ChunkQueue();
  let draining: (() => void) | undefined;
  /**
   * Set the moment the socket is upgraded. Bun keeps calling the RAW socket's handlers after
   * `upgradeTLS` — with the ciphertext — so those handlers go deaf here, or the reader receives
   * TLS records as protocol bytes: a read that never completes, or "closed with 2007 bytes of a
   * partial message".
   */
  let upgraded = false;

  const resume = (): void => {
    const parked = draining;
    draining = undefined;
    parked?.();
  };

  /**
   * A write parked for `drain` can never get one from a socket that is gone, so it is released
   * here; it then fails on the next `write` rather than burning a whole deadline first. The read
   * side ends cleanly because an EOF that matters is already an error one layer up.
   */
  const died = (): void => {
    resume();
    queue.end();
  };

  const connectFailure = (error: Error): ReplicationFailedError =>
    new ReplicationFailedError({
      stage: 'connect',
      detail: error.message,
      fix: `open the route to ${target.host}:${target.port}, then: x doctor db`,
    });

  const handlers: SocketHandlers = {
    // Copied, not retained: Bun promises nothing about the chunk's contents — or that it is even
    // the same buffer — once the handler returns, and this one outlives it in the queue.
    data: (_socket, data) => {
      if (!upgraded) queue.push(data.slice());
    },
    close: () => {
      if (!upgraded) died();
    },
    end: () => {
      if (!upgraded) died();
    },
    drain: () => {
      if (!upgraded) resume();
    },
    error: (_socket, error) => {
      if (!upgraded) queue.fail(connectFailure(error));
    },
  };

  let socket = await runtime.connect({
    hostname: target.host,
    port: target.port,
    socket: handlers,
  });

  const flush = async (bytes: Uint8Array): Promise<void> => {
    let rest = bytes;
    while (rest.length > 0) {
      const written = socket.write(rest);
      if (written >= rest.length) return;
      // A negative count is a refusal, not backpressure: no `drain` follows a dead socket, so
      // waiting for one would park this write forever.
      if (written < 0) {
        throw new ReplicationFailedError({
          stage: 'write',
          detail: `the socket refused a ${rest.length}-byte write`,
          fix: 'the replicator reconnects on its own; confirm the host is up with: x doctor db',
        });
      }
      if (written > 0) rest = rest.subarray(written);
      await new Promise<void>((resolve) => {
        draining = resolve;
      });
    }
  };

  /**
   * The upgrade, awaited to its HANDSHAKE rather than assumed: the runtime is told never to
   * reject (`rejectUnauthorized: false`), because libpq's `prefer` and `require` verify nothing,
   * and `judgeHandshake` decides what its report means under the mode that was asked for. A
   * failure is `X_REPLICATION_TLS` here, never a refused write one step later.
   */
  const upgrade = async (): Promise<SocketLike> => {
    const ca = await rootCertificate(target.rootCert);
    let settle: ((failure: ReplicationTlsError | undefined) => void) | undefined;
    const handshake = new Promise<ReplicationTlsError | undefined>((resolve) => {
      settle = resolve;
    });
    const decide = (failure: ReplicationTlsError | undefined): void => {
      const once = settle;
      settle = undefined;
      once?.(failure);
    };
    const lost = (detail: string): ReplicationTlsError =>
      new ReplicationTlsError({
        detail,
        fix: `confirm ${target.host}:${target.port} is postgres with ssl=on, or use ?sslmode=disable if it does not speak TLS`,
      });
    const tlsHandlers: SocketHandlers = {
      data: (_socket, data) => queue.push(data.slice()),
      close: () => {
        decide(lost('the server closed the connection during the TLS handshake'));
        died();
      },
      end: () => {
        decide(lost('the server ended the connection during the TLS handshake'));
        died();
      },
      drain: resume,
      error: (_socket, error) => {
        decide(lost(`the TLS handshake failed: ${renderThrowable(error)}`));
        queue.fail(connectFailure(error));
      },
      handshake: (_socket, _success, authorizationError) =>
        decide(judgeHandshake(target, authorizationError)),
    };
    upgraded = true;
    // Bun hands back `[raw, tls]`; every later read and write goes through the second one.
    const tls = socket.upgradeTLS({
      tls: {
        serverName: target.host,
        rejectUnauthorized: false,
        ...(ca === undefined ? {} : { ca }),
      },
      socket: tlsHandlers,
    })[1];
    if (tls === undefined) {
      throw new ReplicationFailedError({
        stage: 'ssl',
        detail: 'the runtime returned no TLS socket for the upgrade',
        fix: 'bun upgrade   # in-band TLS needs bun >= 1.3',
      });
    }
    const failure = await handshake;
    if (failure !== undefined) {
      tls.end();
      throw failure;
    }
    return tls;
  };

  if (target.ssl !== 'disable') {
    await flush(sslRequest());
    const answer = (await queue.read()) ?? new Uint8Array(0);
    const verdict = answer[0];
    if (verdict === undefined) {
      throw new ReplicationFailedError({
        stage: 'ssl',
        detail: 'the server closed the connection instead of answering the TLS request',
        fix: `use ?sslmode=disable if ${target.host} does not speak TLS`,
      });
    }
    if (verdict === 0x53) {
      // The answer is exactly one byte: anything after it was written before the handshake and
      // would be read as ciphertext, so it is a wrong peer rather than an early arrival.
      if (answer.length > 1) {
        throw new ReplicationProtocolError({
          stage: 'ssl',
          detail: `the server sent ${answer.length - 1} bytes after accepting TLS`,
          fix: 'point the replication URL at postgres itself — a proxy answers like this',
        });
      }
      socket = await upgrade();
    } else if (target.ssl !== 'allow' && target.ssl !== 'prefer') {
      // `X_REPLICATION_FAILED`, as it always was: a server that says no is a connection outcome,
      // and moving it to the TLS code would break whoever already matches on it.
      throw new ReplicationFailedError({
        stage: 'ssl',
        detail: `the server refused TLS but sslmode=${target.ssl} was asked for`,
        fix: `enable ssl on ${target.host}, or use ?sslmode=prefer to accept a cleartext session`,
      });
    }
  }

  return {
    read: () => queue.read(),
    write: flush,
    close: () => socket.end(),
  };
}
