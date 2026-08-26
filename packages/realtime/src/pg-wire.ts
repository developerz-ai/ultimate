// Single responsibility: the Postgres v3 message frame — reassemble the length-prefixed backend
// messages out of whatever chunk sizes the socket hands us, and build the frontend ones. Nothing
// here knows what a replication slot is; that is `pg-connection.ts`. Nothing here owns a socket;
// the byte pipe is injected, so the whole protocol runs in a test with no network.

import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import { ByteReader, ByteWriter } from './pg-bytes';

/** The byte pipe a connection runs over. `pg-socket.ts` implements it over `Bun.connect`. */
export interface PgStream {
  /** The next chunk the server sent, or `undefined` once it closed the connection. */
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface PgMessage {
  /** The one-byte type code, as its ASCII character. */
  readonly tag: string;
  readonly body: Uint8Array;
}

/** Protocol 3.0, as an Int32 — the number the startup packet leads with instead of a tag. */
export const PROTOCOL_3_0 = 196_608;

/** The magic number that asks for TLS before the startup packet. */
export const SSL_REQUEST_CODE = 80_877_103;

/** A single message is bounded so a corrupt length cannot make us allocate the machine. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Chunks in, whole messages out. A TCP read boundary lands anywhere — halfway through a length
 * prefix, halfway through a 4MB `CopyData` — so the buffer is the only place that knows how many
 * bytes are still missing, and every other module gets to assume a complete frame.
 */
export class MessageReader {
  readonly #stream: PgStream;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(stream: PgStream) {
    this.#stream = stream;
  }

  /** Bytes already read but not yet consumed — what a reconnect would have to replay. */
  get buffered(): number {
    return this.#buffer.length;
  }

  /** The next complete message, or `undefined` at a clean EOF. */
  async next(): Promise<PgMessage | undefined> {
    for (;;) {
      const framed = this.#take();
      if (framed !== undefined) return framed;
      const chunk = await this.#stream.read();
      if (chunk === undefined) {
        if (this.#buffer.length === 0) return undefined;
        throw new ReplicationProtocolError({
          stage: 'read',
          detail: `the connection closed with ${this.#buffer.length} bytes of a partial message`,
          fix: 'x doctor db — the backend was terminated mid-message; the server log names the reason',
        });
      }
      this.#append(chunk);
    }
  }

  #append(chunk: Uint8Array): void {
    if (this.#buffer.length === 0) {
      this.#buffer = chunk;
      return;
    }
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer, 0);
    joined.set(chunk, this.#buffer.length);
    this.#buffer = joined;
  }

  /** A message is `tag` + Int32 length that counts itself but not the tag. */
  #take(): PgMessage | undefined {
    const buffer = this.#buffer;
    if (buffer.length < 5) return undefined;
    const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(
      1,
      false,
    );
    if (length < 4 || length > MAX_MESSAGE_BYTES) {
      throw new ReplicationProtocolError({
        stage: 'read',
        detail: `a message declared a length of ${length} bytes`,
        fix: 'point the replication URL at postgres itself — a proxy or a TLS port frames like this',
      });
    }
    const total = length + 1;
    if (buffer.length < total) return undefined;
    const message: PgMessage = {
      tag: String.fromCharCode(buffer[0] ?? 0),
      body: buffer.subarray(5, total),
    };
    this.#buffer = buffer.subarray(total);
    return message;
  }
}

/** `tag` + Int32 length + body — the shape of every frontend message except the startup packet. */
export const frame = (tag: string, body: Uint8Array): Uint8Array =>
  new ByteWriter(body.length + 5)
    .uint8(tag.charCodeAt(0))
    .int32(body.length + 4)
    .raw(body)
    .finish();

/** The startup packet carries no tag: Int32 length, Int32 version, then `key\0value\0`…`\0`. */
export const startupMessage = (parameters: Readonly<Record<string, string>>): Uint8Array => {
  const body = new ByteWriter(128).int32(PROTOCOL_3_0);
  for (const [key, value] of Object.entries(parameters)) body.cstring(key).cstring(value);
  const payload = body.uint8(0).finish();
  return new ByteWriter(payload.length + 4)
    .int32(payload.length + 4)
    .raw(payload)
    .finish();
};

/** Asks the server whether it will speak TLS. Same no-tag shape as the startup packet. */
export const sslRequest = (): Uint8Array =>
  new ByteWriter(8).int32(8).int32(SSL_REQUEST_CODE).finish();

export const passwordMessage = (password: string): Uint8Array =>
  frame('p', new ByteWriter(password.length + 1).cstring(password).finish());

/** SASLInitialResponse: the mechanism we picked, then the length-prefixed first client message. */
export const saslInitialResponse = (mechanism: string, initial: Uint8Array): Uint8Array =>
  frame(
    'p',
    new ByteWriter(mechanism.length + initial.length + 8)
      .cstring(mechanism)
      .int32(initial.length)
      .raw(initial)
      .finish(),
  );

export const saslResponse = (payload: Uint8Array): Uint8Array => frame('p', payload);

export const queryMessage = (sql: string): Uint8Array =>
  frame('Q', new ByteWriter(sql.length + 1).cstring(sql).finish());

export const terminateMessage = (): Uint8Array => frame('X', new Uint8Array(0));

export const copyDoneMessage = (): Uint8Array => frame('c', new Uint8Array(0));

/**
 * `ErrorResponse` and `NoticeResponse` share a body: `field-code` + String, until a zero byte.
 * `C` is the SQLSTATE, `M` the message, `S` the severity — the three we ever act on.
 */
export const responseFields = (body: Uint8Array): Readonly<Record<string, string>> => {
  const reader = new ByteReader(body, 'error');
  const fields: Record<string, string> = {};
  while (reader.remaining > 0) {
    const code = reader.tag();
    // The list ends with a bare zero byte rather than another field code.
    if (code === '\0') break;
    fields[code] = reader.cstring();
  }
  return fields;
};

/** One line an operator can act on: `28P01 invalid password for user "x"`. */
export const describeFields = (fields: Readonly<Record<string, string>>): string =>
  [fields['C'], fields['M'] ?? 'the server reported no message', fields['D'], fields['H']]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' — ');

/**
 * SQLSTATEs worth their own fix line, because the operator's next command differs for each.
 *
 * Exported for `pg-wire.test.ts` alone, which pins the publication name in `42704` to
 * `DEFAULT_REPLICATION_PUBLICATION` — a test may import `changefeed-env.ts`, and this module may
 * not: `changefeed-env -> changefeed -> pg-replication -> pg-wire` is already a chain, so reading
 * the constant here would close it into a cycle. Not re-exported from `index.ts`.
 */
export const FIXES: Readonly<Record<string, string>> = {
  '28P01': 'correct the password in the replication URL — the server refused the credentials',
  '28000': 'add a `host replication <user> <cidr> scram-sha-256` line to pg_hba.conf and reload',
  '42501': 'grant the role REPLICATION: ALTER ROLE <user> WITH REPLICATION',
  '55006': 'another replicator holds the slot — exactly one replicator per database, by design',
  // NOT `x db replication init`, which this line said until 2026-08-20 and which is not a command:
  // `x db` takes gen, migrate, reset, seed, studio, branch and backfill. It shipped because a fix
  // read out of a TABLE was invisible to the gate — `fix: FIXES[code]` holds no literal — which is
  // the half of #97 that outlived the three log-injection holes. The publication is the operator's
  // to create; the slot the replicator creates for itself on its next start.
  '42704':
    'psql "$REPLICATION_URL" -c "CREATE PUBLICATION x_changes FOR ALL TABLES"' +
    "   # x_changes is the default name; use REPLICATION_PUBLICATION's value where it is set. " +
    "The slot is the replicator's own and it creates one on its next start",
  '0A000': 'set wal_level = logical in postgresql.conf and restart the server',
};

/** What a SQLSTATE this table has no entry for is answered with. */
const GENERIC_FIX = 'x doctor db — the postgres message above names the object to change';

/**
 * An `ErrorResponse` becomes the one error class whose `fix` names the command to run.
 *
 * `Object.hasOwn`, because `code` is `fields['C']` — read off the WIRE, so it is data and this
 * table is keyed by it. `FIXES['constructor']` answered the `Object` function, which is not
 * nullish, so `?? GENERIC_FIX` never fired and `UltimateError` ran `singleLine(fn)`: a `TypeError`
 * out of the constructor of the error that exists to explain the failure, so the caller lost
 * `X_REPLICATION_FAILED`, its cause and its fix at once. `packages/schema/src/errors.ts` shipped
 * the same shape and `scripts/proto-index.ts` was written for it.
 */
export const serverError = (stage: string, body: Uint8Array): ReplicationFailedError => {
  const fields = responseFields(body);
  const code = fields['C'] ?? '';
  return new ReplicationFailedError({
    stage,
    detail: describeFields(fields),
    fix: Object.hasOwn(FIXES, code) ? (FIXES[code] ?? GENERIC_FIX) : GENERIC_FIX,
  });
};
