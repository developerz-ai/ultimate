// Single responsibility: the one scripted Postgres server this package's `PgConnection` tests run
// against — a fake `PgStream` plus a builder per backend message. Two test files need it, and two
// private copies would be two chances to script a frame the real server never sends.
// Not part of the public API — `index.ts` deliberately does not re-export it.

import { ByteReader, ByteWriter } from './pg-bytes';
import { PgConnection, type PgConnectionOptions } from './pg-connection';
import { frame, type PgStream } from './pg-wire';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

/**
 * A scriptable fake `PgStream`. `push()` queues chunks for `read()`; once the queue is empty and
 * the stream has not `end()`-ed, `read()` parks until the next `push()`/`end()` — the shape a test
 * needs to script a real request/response handshake. `write()` records every byte the client sent.
 */
export class FakeStream implements PgStream {
  readonly writes: Uint8Array[] = [];
  readonly #queue: Uint8Array[] = [];
  #ended = false;
  #parked: ((chunk: Uint8Array | undefined) => void) | undefined;
  #closed = false;
  #nextWriteError: Error | undefined;
  #closeError: Error | undefined;

  push(...chunks: readonly Uint8Array[]): void {
    for (const chunk of chunks) {
      const parked = this.#parked;
      if (parked !== undefined) {
        this.#parked = undefined;
        parked(chunk);
      } else {
        this.#queue.push(chunk);
      }
    }
  }

  /** Clean EOF: releases a parked `read()` with `undefined`, and every one after it. */
  end(): void {
    this.#ended = true;
    const parked = this.#parked;
    if (parked !== undefined) {
      this.#parked = undefined;
      parked(undefined);
    }
  }

  throwOnNextWrite(error: Error): void {
    this.#nextWriteError = error;
  }

  /** A socket whose `close()` throws — the failure that must not replace the one being reported. */
  throwOnClose(error: Error): void {
    this.#closeError = error;
  }

  get closed(): boolean {
    return this.#closed;
  }

  read(): Promise<Uint8Array | undefined> {
    const next = this.#queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.#parked = resolve;
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(bytes);
    const error = this.#nextWriteError;
    if (error !== undefined) {
      this.#nextWriteError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  close(): void {
    this.#closed = true;
    if (this.#closeError !== undefined) throw this.#closeError;
  }
}

// --- Backend message builders: one per row of the wire table, `frame()` owns tag + length -------

export const AUTH_OK = 0;
export const AUTH_CLEARTEXT = 3;
export const AUTH_MD5 = 5;
export const AUTH_SASL = 10;
export const AUTH_SASL_CONTINUE = 11;
export const AUTH_SASL_FINAL = 12;
export const AUTH_GSSAPI = 7;

export const authMethod = (method: number, extra: Uint8Array = new Uint8Array(0)): Uint8Array =>
  frame('R', new ByteWriter().int32(method).raw(extra).finish());
export const authOk = (): Uint8Array => authMethod(AUTH_OK);
export const authCleartext = (): Uint8Array => authMethod(AUTH_CLEARTEXT);
export const authMd5 = (salt: Uint8Array): Uint8Array => authMethod(AUTH_MD5, salt);
export const authGssapi = (): Uint8Array => authMethod(AUTH_GSSAPI);
export const authSaslContinue = (payload: Uint8Array): Uint8Array =>
  authMethod(AUTH_SASL_CONTINUE, payload);
export const authSaslFinal = (payload: Uint8Array): Uint8Array =>
  authMethod(AUTH_SASL_FINAL, payload);
export const authSasl = (...mechanisms: readonly string[]): Uint8Array => {
  const writer = new ByteWriter().int32(AUTH_SASL);
  for (const mechanism of mechanisms) writer.cstring(mechanism);
  return frame('R', writer.uint8(0).finish());
};

export const parameterStatus = (name: string, value: string): Uint8Array =>
  frame('S', new ByteWriter().cstring(name).cstring(value).finish());

export const backendKeyData = (pid: number, secret: number): Uint8Array =>
  frame('K', new ByteWriter().int32(pid).int32(secret).finish());

export const READY_IDLE = 'I'.charCodeAt(0);
export const readyForQuery = (): Uint8Array =>
  frame('Z', new ByteWriter().uint8(READY_IDLE).finish());

export const rowDescriptionStub = (): Uint8Array => frame('T', new Uint8Array(0));

export const dataRow = (...values: readonly (string | null)[]): Uint8Array => {
  const writer = new ByteWriter().int16(values.length);
  for (const value of values) {
    if (value === null) {
      writer.int32(-1);
    } else {
      const bytes = encoder.encode(value);
      writer.int32(bytes.length).raw(bytes);
    }
  }
  return frame('D', writer.finish());
};

export const commandComplete = (tag: string): Uint8Array =>
  frame('C', new ByteWriter().cstring(tag).finish());

export const fieldedMessage = (
  tag: 'E' | 'N',
  fields: Readonly<Record<string, string>>,
): Uint8Array => {
  const writer = new ByteWriter();
  for (const [code, value] of Object.entries(fields)) {
    writer.uint8(code.charCodeAt(0)).cstring(value);
  }
  return frame(tag, writer.uint8(0).finish());
};
export const errorResponse = (fields: Readonly<Record<string, string>>): Uint8Array =>
  fieldedMessage('E', fields);
export const noticeResponse = (fields: Readonly<Record<string, string>>): Uint8Array =>
  fieldedMessage('N', fields);

export const copyBothResponse = (): Uint8Array =>
  frame('W', new ByteWriter().uint8(0).int16(0).finish());
export const copyData = (payload: Uint8Array): Uint8Array => frame('d', payload);
export const copyDoneFrame = (): Uint8Array => frame('c', new Uint8Array(0));

/** One frontend `tag` + Int32 length + body frame — the shape `frame()` builds. */
export const decodeFrame = (bytes: Uint8Array): { tag: string; body: Uint8Array } => {
  const reader = new ByteReader(bytes);
  const tag = reader.tag();
  const length = reader.int32();
  return { tag, body: reader.take(length - 4) };
};

/** The tagless startup packet: Int32 length, Int32 version, then key/value cstrings to `\0`. */
export const decodeStartup = (
  bytes: Uint8Array,
): { version: number; params: Record<string, string> } => {
  const reader = new ByteReader(bytes);
  reader.int32(); // total length — implied by `bytes.length`, not needed to check the shape
  const version = reader.int32();
  const params: Record<string, string> = {};
  for (;;) {
    const key = reader.cstring();
    if (key === '') break;
    params[key] = reader.cstring();
  }
  return { version, params };
};

export const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// --- Fixtures --------------------------------------------------------------------------------

export const opts = (
  stream: PgStream,
  extra?: Partial<PgConnectionOptions>,
): PgConnectionOptions => ({
  stream,
  user: 'repluser',
  database: 'app',
  ...extra,
});

/** A connection past the handshake, via the cheapest auth method — trust. */
export async function openTrusted(
  stream: FakeStream,
  extra?: Partial<PgConnectionOptions>,
): Promise<PgConnection> {
  stream.push(authOk(), readyForQuery());
  return PgConnection.open(opts(stream, extra));
}

export const START_REPLICATION_SQL = 'START_REPLICATION SLOT s LOGICAL 0/0';

export async function openInCopyBoth(stream: FakeStream): Promise<PgConnection> {
  const connection = await openTrusted(stream);
  stream.push(copyBothResponse());
  await connection.startCopyBoth(START_REPLICATION_SQL);
  return connection;
}
