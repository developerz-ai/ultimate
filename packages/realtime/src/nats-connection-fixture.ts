// Single responsibility: the scripted stream and the two `open()` shorthands this package's NATS
// session tests share. Split out of `nats-connection.test.ts` so neither file outgrows its
// ceiling. Not part of the public API — `index.ts` deliberately does not re-export it.

import { isUltimateError } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import { NatsConnection } from './nats-connection';
import type { FakeNatsServer } from './nats-fake';
import type { NatsStream, NatsTarget } from './nats-socket';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export const TARGET: NatsTarget = {
  host: 'bus.test',
  port: 4222,
  tls: false,
  user: undefined,
  pass: undefined,
  token: undefined,
};

export const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

export const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** A stream whose server side is a script: the test pushes bytes and reads what the client wrote. */
export class ScriptedStream implements NatsStream {
  readonly writes: string[] = [];
  /**
   * A socket that rejects a frame — the fault the session has to survive without keeping state
   * that claims the frame arrived. A refused frame still lands in `writes`: the client did hand
   * it over, and counting attempts is how a test sees a retry.
   */
  refuse: (frame: string) => boolean = () => false;
  upgrades = 0;
  closed = false;
  readonly #queue: (Uint8Array | undefined)[] = [];
  #waiting: ((chunk: Uint8Array | undefined) => void) | undefined;

  constructor(...script: string[]) {
    for (const text of script) this.push(text);
  }

  push(text: string): void {
    const chunk = encoder.encode(text);
    const waiter = this.#waiting;
    this.#waiting = undefined;
    if (waiter) waiter(chunk);
    else this.#queue.push(chunk);
  }

  eof(): void {
    const waiter = this.#waiting;
    this.#waiting = undefined;
    if (waiter) waiter(undefined);
    else this.#queue.push(undefined);
  }

  read(): Promise<Uint8Array | undefined> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    const frame = decoder.decode(bytes);
    this.writes.push(frame);
    if (this.refuse(frame)) {
      throw new TransportUnavailableError({ transport: 'nats', reason: `refused: ${frame}` });
    }
  }

  upgradeTls(): void {
    this.upgrades += 1;
  }

  close(): void {
    this.closed = true;
    this.eof();
  }
}

export const INFO =
  'INFO {"server_id":"S","version":"2.11.0","max_payload":1048576,"headers":true}\r\n';

export const openScripted = async (
  stream: ScriptedStream,
  target: NatsTarget = TARGET,
): Promise<NatsConnection> =>
  await NatsConnection.open({ stream, target, rng: () => 0.5, requestTimeoutMs: 50 });

export const openFake = async (server: FakeNatsServer): Promise<NatsConnection> =>
  await NatsConnection.open({
    stream: server.connect(),
    target: TARGET,
    rng: () => 0.5,
    requestTimeoutMs: 200,
  });
