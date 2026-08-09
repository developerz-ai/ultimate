// Single responsibility: the one production `SmtpStream`, over `Bun.connect`. Bun pushes bytes at
// handlers while the conversation pulls replies, so a queue sits between them; `startTls` swaps in
// the upgraded socket for STARTTLS. Nothing here knows an SMTP verb — that is `smtp-client.ts`.

import { sendFailed } from './errors';
import type { SmtpStream, SmtpTarget } from './smtp-client';

/** Structural view of Bun's socket — declared here so the contract does not depend on bun-types. */
interface SocketLike {
  write(data: Uint8Array): number;
  end(): void;
  upgradeTLS(options: {
    readonly tls: { readonly serverName: string };
    readonly socket: SocketHandlers;
  }): readonly SocketLike[];
}

interface SocketHandlers {
  data(socket: SocketLike, data: Uint8Array): void;
  close(): void;
  end(): void;
  drain(): void;
  error(socket: SocketLike, error: Error): void;
}

interface BunConnect {
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bunSmtpStream(target: SmtpTarget): Promise<SmtpStream> {
  const queue = new ChunkQueue();
  let drained: (() => void) | undefined;

  const handlers: SocketHandlers = {
    data: (_socket, data) => queue.push(decoder.decode(data)),
    close: () => queue.end(),
    end: () => queue.end(),
    drain: () => {
      const waiter = drained;
      drained = undefined;
      waiter?.();
    },
    error: (_socket, error) => queue.fail(error),
  };

  const opening = (Bun as unknown as BunConnect).connect({
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
          drained = undefined;
          reject(
            sendFailed({
              driver: 'smtp',
              stage: 'data',
              detail: `the socket stopped accepting bytes for ${target.timeoutMs}ms`,
              retryable: true,
              fix: 'raise timeoutMs on createSmtpDriver, or check the route to the SMTP host',
            }),
          );
        }, target.timeoutMs);
        drained = (): void => {
          clearTimeout(timer);
          resolve();
        };
      });

    const flush = async (bytes: Uint8Array): Promise<void> => {
      let rest = bytes;
      while (rest.length > 0) {
        const written = socket.write(rest);
        if (written >= rest.length) return;
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
        return Promise.resolve();
      },
      close: () => {
        socket.end();
      },
    };
  });
}
