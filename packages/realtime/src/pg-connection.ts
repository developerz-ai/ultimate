// Single responsibility: one Postgres session over a `PgStream` — startup, authentication, simple
// queries, and the CopyBoth switch that a replication stream lives inside. It speaks only in
// messages, never in bytes on a socket, so the whole handshake is driven by hand in the tests.

import { logger } from '@ultimat3/core';
import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import {
  chooseMechanism,
  md5Password,
  type ScramSession,
  scramNonce,
  scramSession,
} from './pg-auth';
import { ByteReader } from './pg-bytes';
import {
  copyDoneMessage,
  frame,
  MessageReader,
  type PgMessage,
  type PgStream,
  passwordMessage,
  queryMessage,
  responseFields,
  saslInitialResponse,
  saslResponse,
  serverError,
  startupMessage,
  terminateMessage,
} from './pg-wire';
import type { Rng } from './thundering-herd';

export interface PgConnectionOptions {
  readonly stream: PgStream;
  readonly user: string;
  readonly password?: string | undefined;
  readonly database: string;
  /**
   * `database` opens a logical-replication walsender that *also* answers ordinary SQL — which is
   * what lets one connection check `wal_level` and then stream from a slot.
   */
  readonly replication?: 'database' | undefined;
  readonly applicationName?: string | undefined;
  /** Injected so the SCRAM nonce is deterministic under a seeded test. */
  readonly rng?: Rng | undefined;
}

/** A result set as text, exactly as the wire carries it. `null` is SQL NULL, never `''`. */
export type PgRows = readonly (readonly (string | null)[])[];

const AUTH_OK = 0;
const AUTH_CLEARTEXT = 3;
const AUTH_MD5 = 5;
const AUTH_SASL = 10;
const AUTH_SASL_CONTINUE = 11;
const AUTH_SASL_FINAL = 12;

const needPassword = (method: string): ReplicationFailedError =>
  new ReplicationFailedError({
    stage: 'auth',
    detail: `the server asked for ${method} but the replication URL carries no password`,
    fix: 'put the credentials in the URL: postgres://user:password@host:5432/db',
  });

export class PgConnection {
  readonly #stream: PgStream;
  readonly #reader: MessageReader;
  readonly #parameters = new Map<string, string>();
  #copyBoth = false;
  #closed = false;

  private constructor(stream: PgStream) {
    this.#stream = stream;
    this.#reader = new MessageReader(stream);
  }

  /** Startup, authentication, and everything up to the first `ReadyForQuery`. */
  static async open(options: PgConnectionOptions): Promise<PgConnection> {
    const connection = new PgConnection(options.stream);
    const parameters: Record<string, string> = {
      user: options.user,
      database: options.database,
      application_name: options.applicationName ?? 'ultimate-replicator',
    };
    // A walsender rejects most GUCs, so only the two it accepts are sent.
    if (options.replication !== undefined) parameters['replication'] = options.replication;
    // A handshake fails on ordinary conditions — no password, an ErrorResponse, an EOF — and on
    // every one of them the caller gets an exception instead of an object, so nothing is left
    // holding the socket. Closing it here is what stops a retrying supervisor from accumulating
    // one file descriptor per failed attempt.
    try {
      await options.stream.write(startupMessage(parameters));
      await connection.#authenticate(options);
      await connection.#awaitReady();
    } catch (failure) {
      closeQuietly(options.stream);
      throw failure;
    }
    return connection;
  }

  /** A `ParameterStatus` the server volunteered — `server_version`, `integer_datetimes`, … */
  parameter(name: string): string | undefined {
    return this.#parameters.get(name);
  }

  get inCopyBoth(): boolean {
    return this.#copyBoth;
  }

  /** One simple query. Returns the rows as text; a `CommandComplete` with no rows returns `[]`. */
  async query(sql: string): Promise<PgRows> {
    await this.#stream.write(queryMessage(sql));
    const rows: (readonly (string | null)[])[] = [];
    for (;;) {
      const message = await this.#expect('query');
      switch (message.tag) {
        case 'D':
          rows.push(dataRow(message.body));
          break;
        case 'E':
          // Drain to `ReadyForQuery` first: leaving the session mid-result desynchronises reuse.
          await this.#drainToReady();
          throw serverError('query', message.body);
        case 'Z':
          return rows;
        default:
          this.#note(message);
      }
    }
  }

  /**
   * `START_REPLICATION` — the connection stops being request/response and becomes a duplex copy
   * stream. There is no way back short of closing it, which is why this is one-way on purpose.
   */
  async startCopyBoth(sql: string): Promise<void> {
    await this.#stream.write(queryMessage(sql));
    for (;;) {
      const message = await this.#expect('start-replication');
      if (message.tag === 'W') {
        this.#copyBoth = true;
        return;
      }
      if (message.tag === 'E') throw serverError('start-replication', message.body);
      this.#note(message);
    }
  }

  /** The next `CopyData` payload, or `undefined` when the server ended the stream. */
  async nextCopyData(): Promise<Uint8Array | undefined> {
    for (;;) {
      const message = await this.#reader.next();
      if (message === undefined) return undefined;
      switch (message.tag) {
        case 'd':
          return message.body;
        case 'c':
          this.#copyBoth = false;
          return undefined;
        case 'E':
          throw serverError('stream', message.body);
        default:
          this.#note(message);
      }
    }
  }

  /** Frontend `CopyData` — how a standby status update reaches the walsender. */
  async sendCopyData(payload: Uint8Array): Promise<void> {
    await this.#stream.write(frame('d', payload));
  }

  /**
   * End the copy stream from this side. Saying so is what lets the server release the slot at
   * once; dropping the socket instead leaves it `active` until the backend notices.
   */
  async endCopy(): Promise<void> {
    if (!this.#copyBoth) return;
    await this.#stream.write(copyDoneMessage());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Best effort: a walsender that already died does not need to hear the goodbye.
    try {
      await this.#stream.write(terminateMessage());
    } catch {
      // fall through to the socket close below
    }
    this.#stream.close();
  }

  async #authenticate(options: PgConnectionOptions): Promise<void> {
    let scram: ScramSession | undefined;
    for (;;) {
      const message = await this.#expect('auth');
      if (message.tag === 'E') throw serverError('auth', message.body);
      if (message.tag !== 'R') {
        this.#note(message);
        continue;
      }
      const reader = new ByteReader(message.body, 'auth');
      const method = reader.int32();
      switch (method) {
        case AUTH_OK:
          return;
        case AUTH_CLEARTEXT: {
          const password = options.password ?? '';
          if (password === '') throw needPassword('a cleartext password');
          await this.#stream.write(passwordMessage(password));
          break;
        }
        case AUTH_MD5: {
          const password = options.password ?? '';
          if (password === '') throw needPassword('an md5 password');
          const salt = reader.take(4);
          await this.#stream.write(
            passwordMessage(md5Password({ user: options.user, password, salt })),
          );
          break;
        }
        case AUTH_SASL: {
          const password = options.password ?? '';
          if (password === '') throw needPassword('a SCRAM password');
          const mechanism = chooseMechanism(mechanisms(reader));
          // No `?? Math.random`: an absent `rng` must reach `scramNonce`'s CSPRNG default, which
          // is the only source RFC 5802 allows for a client nonce.
          scram = scramSession({ password, nonce: scramNonce(options.rng) });
          await this.#stream.write(saslInitialResponse(mechanism, scram.clientFirst()));
          break;
        }
        case AUTH_SASL_CONTINUE: {
          if (scram === undefined) throw outOfOrder('SASLContinue');
          await this.#stream.write(saslResponse(await scram.clientFinal(reader.rest())));
          break;
        }
        case AUTH_SASL_FINAL: {
          if (scram === undefined) throw outOfOrder('SASLFinal');
          await scram.verify(reader.rest());
          break;
        }
        default:
          throw new ReplicationProtocolError({
            stage: 'auth',
            detail: `the server asked for authentication method ${method}, which this client does not speak`,
            fix: 'set password_encryption = scram-sha-256 and give the replication role a password',
          });
      }
    }
  }

  /** Everything between `AuthenticationOk` and the first `ReadyForQuery` is session metadata. */
  async #awaitReady(): Promise<void> {
    for (;;) {
      const message = await this.#expect('startup');
      if (message.tag === 'Z') return;
      if (message.tag === 'E') throw serverError('startup', message.body);
      this.#note(message);
    }
  }

  async #drainToReady(): Promise<void> {
    for (;;) {
      const message = await this.#reader.next();
      if (message === undefined || message.tag === 'Z') return;
    }
  }

  async #expect(stage: string): Promise<PgMessage> {
    const message = await this.#reader.next();
    if (message !== undefined) return message;
    throw new ReplicationFailedError({
      stage,
      detail:
        'the server closed the connection without answering — pg_hba.conf needs a ' +
        '"host replication <user> <cidr> scram-sha-256" line before it will hold one open',
      fix: 'psql "$DATABASE_URL" -c "SELECT pg_reload_conf()" -c "TABLE pg_hba_file_rules"',
    });
  }

  /** Messages that carry session state or server chatter, in one place so nothing is dropped. */
  #note(message: PgMessage): void {
    switch (message.tag) {
      case 'S': {
        const reader = new ByteReader(message.body, 'parameter-status');
        this.#parameters.set(reader.cstring(), reader.cstring());
        return;
      }
      case 'N':
        logger.warn('postgres notice', responseFields(message.body));
        return;
      // BackendKeyData, RowDescription, CommandComplete, EmptyQuery, NoticeResponse, Notification:
      // nothing downstream reads them, and dropping them silently is the point of this branch.
      default:
        return;
    }
  }
}

const outOfOrder = (what: string): ReplicationProtocolError =>
  new ReplicationProtocolError({
    stage: 'auth',
    detail: `the server sent ${what} before it offered a SASL mechanism`,
    fix: 'x doctor db — the SASL exchange arrived out of order; check for a pooler or proxy between this client and postgres',
  });

/** A `close()` that throws must not replace the handshake failure that is worth reporting. */
const closeQuietly = (stream: PgStream): void => {
  try {
    stream.close();
  } catch {
    // the original failure is the one the caller needs
  }
};

/** The mechanism list is cstrings until an empty one. */
const mechanisms = (reader: ByteReader): readonly string[] => {
  const offered: string[] = [];
  for (;;) {
    const name = reader.cstring();
    if (name === '') return offered;
    offered.push(name);
  }
};

/** `DataRow`: Int16 column count, then Int32 length (-1 = NULL) + that many bytes, per column. */
const dataRow = (body: Uint8Array): readonly (string | null)[] => {
  const reader = new ByteReader(body, 'data-row');
  const count = reader.int16();
  const values: (string | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = reader.int32();
    values.push(length < 0 ? null : reader.utf8(length));
  }
  return values;
};
