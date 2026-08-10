// Single responsibility: the one production `SmtpStream`, over `Bun.connect`. Bun pushes bytes at
// handlers while the conversation pulls replies, so a queue sits between them; `startTls` swaps in
// the upgraded socket for STARTTLS. Nothing here knows an SMTP verb — that is `smtp-client.ts`.

import { type MailError, sendFailed } from './errors';
import type { SmtpStream, SmtpTarget } from './smtp-client';

/** Structural view of Bun's socket — declared here so the contract does not depend on bun-types. */
export interface SocketLike {
  write(data: Uint8Array): number;
  end(): void;
  upgradeTLS(options: {
    readonly tls: { readonly serverName: string };
    readonly socket: SocketHandlers;
  }): readonly SocketLike[];
}

export interface SocketHandlers {
  data(socket: SocketLike, data: Uint8Array): void;
  close(): void;
  end(): void;
  drain(): void;
  error(socket: SocketLike, error: Error): void;
}

export interface BunConnect {
  connect(options: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: boolean;
    readonly socket: SocketHandlers;
  }): Promise<SocketLike>;
}

interface Waiter {
  readonly resolve: (chunk: string | undefined) => void;
  readonly reject: (error: Error) => void;
}

/** Chunks the socket pushed, handed out one `read()` at a time — EOF and socket errors included. */
class ChunkQueue {
  private readonly chunks: string[] = [];
  private waiting: Waiter | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(chunk: string): void {
    const waiter = this.take();
    if (waiter === undefined) {
      this.chunks.push(chunk);
      return;
    }
    waiter.resolve(chunk);
  }

  /** EOF. A reader parked on `read()` is released rather than left hanging forever. */
  end(): void {
    this.ended = true;
    this.take()?.resolve(undefined);
  }

  /** A socket-level failure (TLS, reset) reaches the caller instead of looking like a clean EOF. */
  fail(error: Error): void {
    this.failure = error;
    this.ended = true;
    this.take()?.reject(error);
  }

  read(): Promise<string | undefined> {
    const next = this.chunks.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  private take(): Waiter | undefined {
    const waiter = this.waiting;
    this.waiting = undefined;
    return waiter;
  }
}

/** A write parked for backpressure: released by `drain`, failed by whatever ends the socket. */
interface DrainWaiter {
  readonly resolve: () => void;
  readonly reject: (error: MailError) => void;
}

/**
 * Which TLS negotiation is in flight, and therefore how a failure now has to be reported: `tls` is
 * the implicit handshake an `smtps://` connection opens with, `starttls` the in-band upgrade. Both
 * windows close on the first byte back — encrypted bytes only flow once the handshake completed,
 * so that first chunk is the proof it did. `undefined` is a channel with no handshake pending.
 */
type Handshake = 'tls' | 'starttls' | undefined;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bunSmtpStream(target: SmtpTarget): Promise<SmtpStream> {
  return smtpStreamOver(Bun as unknown as BunConnect, target);
}

/**
 * `bunSmtpStream` with the runtime handed in. A `write` that returns `-1`, an `error` during the
 * TLS handoff and a `drain` that never comes are all unreachable over a real socket, and each one
 * used to cost a full deadline or a wrong stage — so they are driven by hand in the tests.
 */
export function smtpStreamOver(runtime: BunConnect, target: SmtpTarget): Promise<SmtpStream> {
  const queue = new ChunkQueue();
  let draining: DrainWaiter | undefined;
  // `smtps://` hands the socket to TLS before a single SMTP byte is exchanged, so the window is
  // already open when the connection is made; a plaintext one opens it at `startTls()` or never.
  let handshake: Handshake = target.tls ? 'tls' : undefined;

  /**
   * A failed handshake is a refused certificate or a protocol mismatch, and the same attempt fails
   * identically forever — reporting it as retryable requeues a job against a wall. The two windows
   * differ only in the command that reproduces them, so they are two stages, not one.
   */
  const handshakeFailure = (kind: 'tls' | 'starttls', detail: string): MailError =>
    sendFailed({
      driver: 'smtp',
      stage: kind,
      detail: `the TLS handshake with ${target.host} failed: ${detail}`,
      retryable: false,
      fix:
        `check the certificate and protocol the host offers: openssl s_client ` +
        `${kind === 'starttls' ? '-starttls smtp ' : ''}-connect ${target.host}:${target.port}`,
    });

  /** Outside a handshake, a dead socket really is transient — a reset, a rate limit, a restart. */
  const socketFailure = (detail: string): MailError =>
    handshake === undefined
      ? sendFailed({
          driver: 'smtp',
          stage: 'data',
          detail,
          retryable: true,
          fix: `read the SMTP server log on ${target.host} — the job will retry automatically`,
        })
      : handshakeFailure(handshake, detail);

  const failDrain = (error: MailError): void => {
    const waiter = draining;
    draining = undefined;
    waiter?.reject(error);
  };

  /** What an ended socket means, in one place: `close` and `end` differ only in their wording. */
  const died = (detail: string): void => {
    // A write parked for `drain` can never get one from a socket that is gone; failing it here is
    // the difference between an immediate error and burning the whole deadline first.
    if (draining !== undefined) failDrain(socketFailure(detail));
    // EOF inside a handshake window is a refused handshake, not the clean end of a conversation.
    if (handshake !== undefined) queue.fail(socketFailure(detail));
    else queue.end();
  };

  const handlers: SocketHandlers = {
    data: (_socket, data) => {
      handshake = undefined;
      queue.push(decoder.decode(data));
    },
    close: () => died('the socket closed'),
    end: () => died('the server half-closed the socket'),
    drain: () => {
      const waiter = draining;
      draining = undefined;
      waiter?.resolve();
    },
    error: (_socket, error) => {
      const failure = socketFailure(error.message);
      failDrain(failure);
      queue.fail(failure);
    },
  };

  const opening = runtime.connect({
    hostname: target.host,
    port: target.port,
    tls: target.tls,
    socket: handlers,
  });

  return opening.then((opened): SmtpStream => {
    let socket = opened;

    const waitForDrain = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          draining = undefined;
          reject(
            sendFailed({
              driver: 'smtp',
              stage: 'data',
              detail: `the socket stopped accepting bytes for ${target.timeoutMs}ms`,
              retryable: true,
              fix: 'raise the write deadline: createSmtpDriver({ url: SMTP_URL, timeoutMs: 60_000 })',
            }),
          );
        }, target.timeoutMs);
        draining = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      });

    const flush = async (bytes: Uint8Array): Promise<void> => {
      let rest = bytes;
      while (rest.length > 0) {
        const written = socket.write(rest);
        if (written >= rest.length) return;
        // A negative count is a refusal, not backpressure: no `drain` follows a socket that cannot
        // emit one, so waiting for it would park this write until the deadline and call a closed
        // connection a slow one.
        if (written < 0) throw socketFailure(`the socket refused a ${rest.length}-byte write`);
        // Backpressure: a 200KB message does not fit one buffer. Wait for `drain`, bounded by the
        // same deadline as a read so a stalled socket cannot hold a worker slot forever.
        if (written > 0) rest = rest.subarray(written);
        await waitForDrain();
      }
    };

    return {
      read: () => queue.read(),
      write: (data: string) => flush(encoder.encode(data)),
      startTls: () => {
        // Bun hands back `[raw, tls]`; every later read and write goes through the second one, and
        // the handlers are re-registered because the upgraded socket is a different object.
        const upgraded = socket.upgradeTLS({
          tls: { serverName: target.host },
          socket: handlers,
        })[1];
        if (upgraded === undefined) {
          return Promise.reject(
            sendFailed({
              driver: 'smtp',
              stage: 'starttls',
              detail: 'the runtime returned no TLS socket for the STARTTLS upgrade',
              retryable: false,
              fix: 'upgrade the runtime: bun upgrade   # STARTTLS needs bun >= 1.3',
            }),
          );
        }
        socket = upgraded;
        // Writes made now are buffered by the runtime until the handshake completes, so the client
        // may send EHLO straight away — what changes is how a failure from here is reported.
        handshake = 'starttls';
        return Promise.resolve();
      },
      close: () => {
        socket.end();
      },
    };
  });
}
