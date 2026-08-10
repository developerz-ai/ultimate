// Single responsibility: turn a Postgres logical-replication slot into ordered `ChangeEvent`s —
// preflight the three things that are always misconfigured, START_REPLICATION, decode pgoutput,
// and keep the slot confirmed. The connection, the framing and the pgoutput decode live next door;
// what is decided here is *ordering*, because the lsn is the only authority the pipeline has.

import { type Clock, logger, systemClock } from '@ultimat3/core';
import type { ChangeEvent, ChangeOp, PgLogicalReplicationOptions } from './changefeed';
import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import { isRow, type JsonObject, type Row } from './json';
import { ByteReader, ByteWriter, epochMsToPgTimestamp, printLsn } from './pg-bytes';
import { PgConnection } from './pg-connection';
import { entityRow } from './pg-entity-row';
import { bunPgStream, parsePgUrl } from './pg-socket';
import { PgOutputDecoder, type PgOutputMessage, type PgRelation } from './pgoutput';

/** Identifiers reach a simple query unparameterised, so the charset is the injection boundary. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const DEFAULT_STATUS_INTERVAL_MS = 10_000;

/** `r` — the standby status update, the only frontend message a walsender listens for. */
const STANDBY_STATUS = 0x72;

export interface ReplicationStreamStats {
  readonly delivered: number;
  /** Rows for a table outside the entity list — the publication is wider than the app is. */
  readonly skipped: number;
  /** Rows replayed from before the resume position, dropped so `onChange` sees each one once. */
  readonly replayed: number;
  /**
   * Why the pump stopped, or `null` while it is live. The read loop cannot throw into a caller —
   * nothing awaits it — so this is the one place `/readyz` and a test can see that it died at all.
   */
  readonly failure: string | null;
}

interface Transaction {
  readonly commitLsn: bigint;
  readonly commitAt: number;
  readonly xid: number;
  /** Position of the next row inside this transaction. Reproducible, which is what makes it usable. */
  sequence: number;
}

/**
 * `<commit lsn><position in transaction>`, both zero-padded hex, so string order is stream order.
 *
 * The commit lsn alone is not enough: every row of one transaction shares it, and the replicator
 * drops anything that does not strictly increase — a five-row insert would deliver one row. The
 * per-record WAL position is not enough either: logical decoding emits *transactions* in commit
 * order, so a later-committing transaction can carry lower record positions than an earlier one.
 * The pair is monotonic in the order changes are delivered and identical on replay, which is what
 * makes an at-least-once redelivery deduplicate instead of duplicating.
 */
export const changeLsn = (commitLsn: bigint, sequence: number): string =>
  commitLsn.toString(16).padStart(16, '0') + sequence.toString(16).padStart(8, '0');

/** The commit position inside a change lsn — where a resume asks the server to restart. */
export const commitPositionOf = (lsn: string): bigint => BigInt(`0x${lsn.slice(0, 16) || '0'}`);

const assertIdentifier = (kind: string, value: string): string => {
  if (IDENTIFIER.test(value)) return value;
  throw new ReplicationFailedError({
    stage: 'preflight',
    detail: `${kind} "${value}" is not a lower-case postgres identifier`,
    fix: `rename the ${kind} to match [a-z_][a-z0-9_]* — it is interpolated into a replication command`,
  });
};

export interface ReplicationStreamHandlers {
  readonly from?: string | undefined;
  onChange(event: ChangeEvent): void | Promise<void>;
}

/**
 * One slot, one connection, one process. Started by `PgLogicalReplicationFeed`, which is itself
 * held by the single `replicator` role — the advisory lock upstream is what keeps that "one" true.
 */
export class PgReplicationStream {
  readonly #options: PgLogicalReplicationOptions;
  readonly #clock: Clock;
  readonly #entities: ReadonlySet<string>;
  readonly #decoder = new PgOutputDecoder();
  #connection: PgConnection | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #transaction: Transaction | null = null;
  #confirmed = 0n;
  #lastLsn: string | null = null;
  #running = false;
  #pump: Promise<void> | null = null;
  #delivered = 0;
  #skipped = 0;
  #replayed = 0;
  #failure: string | null = null;

  constructor(options: PgLogicalReplicationOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#entities = new Set(options.entities.map((name) => assertIdentifier('entity', name)));
  }

  lastLsn(): string | null {
    return this.#lastLsn;
  }

  stats(): ReplicationStreamStats {
    return {
      delivered: this.#delivered,
      skipped: this.#skipped,
      replayed: this.#replayed,
      failure: this.#failure,
    };
  }

  /** Resolves once the stream is live. Delivery continues on the pump until `stop()`. */
  async start(handlers: ReplicationStreamHandlers): Promise<void> {
    if (this.#running) return;
    const slot = assertIdentifier('slot', this.#options.slot);
    const publication = assertIdentifier('publication', this.#options.publication);
    const target = parsePgUrl(this.#options.url);
    const stream = await (this.#options.stream ?? bunPgStream)(target);
    const connection = await PgConnection.open({
      stream,
      user: target.user,
      password: target.password,
      database: target.database,
      replication: 'database',
      applicationName: `ultimate-replicator:${slot}`,
      rng: this.#options.rng,
    });
    this.#connection = connection;
    try {
      await preflight(connection, slot, publication);
      const from = handlers.from;
      this.#confirmed = from === undefined ? 0n : commitPositionOf(from);
      await connection.startCopyBoth(
        `START_REPLICATION SLOT ${slot} LOGICAL ${printLsn(this.#confirmed)} ` +
          `(proto_version '1', publication_names '${publication}')`,
      );
    } catch (failure) {
      await this.stop();
      throw failure;
    }
    this.#running = true;
    this.#timer = setInterval(() => {
      void this.#confirm();
    }, this.#options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS);
    // A pending timer must not be what keeps `x dev` alive after the app is done with it.
    this.#timer.unref?.();
    this.#pump = this.#drain(connection, handlers);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const connection = this.#connection;
    this.#connection = null;
    if (connection === null) return;
    // Confirming before the goodbye is what stops a restart from replaying the whole window.
    if (connection.inCopyBoth) {
      await this.#confirm(connection);
      await connection.endCopy();
    }
    await connection.close();
    const pump = this.#pump;
    this.#pump = null;
    if (pump !== null) await pump;
  }

  /** The read loop. It owns no timers and no state beyond the current transaction. */
  async #drain(connection: PgConnection, handlers: ReplicationStreamHandlers): Promise<void> {
    try {
      for (;;) {
        const payload = await connection.nextCopyData();
        if (payload === undefined) return;
        const reader = new ByteReader(payload, 'copy-data');
        const tag = reader.tag();
        if (tag === 'w') {
          reader.int64();
          reader.int64();
          reader.int64();
          await this.#apply(this.#decoder.decode(reader.rest()), handlers);
        } else if (tag === 'k') {
          const walEnd = reader.int64();
          reader.int64();
          const replyRequested = reader.uint8();
          // Only safe between transactions: inside one, the undelivered tail is still pending.
          if (this.#transaction === null && walEnd > this.#confirmed) this.#confirmed = walEnd;
          if (replyRequested === 1) await this.#confirm(connection);
        } else {
          throw new ReplicationProtocolError({
            stage: 'stream',
            detail: `the walsender sent CopyData "${tag}", which is neither XLogData nor a keepalive`,
            fix: 'upgrade this package — the server speaks a replication message it does not know',
          });
        }
      }
    } catch (failure) {
      if (!this.#running) return;
      this.#running = false;
      // The supervisor reads /readyz, so the loop records, reports and ends rather than throwing
      // into a timer callback nothing awaits — and the confirm timer stops with the loop it
      // confirms for, or it keeps telling the walsender a dead stream is still keeping up.
      this.#failure = failure instanceof Error ? failure.message : String(failure);
      if (this.#timer !== null) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
      logger.error('replication stream ended', {
        slot: this.#options.slot,
        error: this.#failure,
      });
    }
  }

  async #apply(message: PgOutputMessage, handlers: ReplicationStreamHandlers): Promise<void> {
    switch (message.kind) {
      case 'begin':
        this.#transaction = {
          commitLsn: message.commitLsn,
          commitAt: message.commitAt,
          xid: message.xid,
          sequence: 0,
        };
        return;
      case 'commit':
        this.#transaction = null;
        if (message.endLsn > this.#confirmed) this.#confirmed = message.endLsn;
        return;
      case 'insert':
        await this.#deliver('insert', message.relation, null, message.after, handlers);
        return;
      case 'update':
        await this.#deliver('update', message.relation, message.before, message.after, handlers);
        return;
      case 'delete':
        await this.#deliver('delete', message.relation, message.before, null, handlers);
        return;
      default:
        // Relation, truncate, origin, type, logical message: nothing the matcher can act on.
        return;
    }
  }

  async #deliver(
    op: ChangeOp,
    relation: PgRelation,
    oldTuple: JsonObject | null,
    newTuple: JsonObject | null,
    handlers: ReplicationStreamHandlers,
  ): Promise<void> {
    const transaction = this.#transaction;
    if (transaction === null) {
      throw new ReplicationProtocolError({
        stage: 'stream',
        detail: `a ${op} arrived outside a transaction`,
        fix: 'upgrade this package — the pgoutput stream is framed differently than expected',
      });
    }
    // Counted for every row, selected or not, so the lsn depends on the WAL alone: narrowing the
    // entity list must not renumber a stream a resume cursor already points into.
    transaction.sequence += 1;
    if (!this.#entities.has(relation.name)) {
      this.#skipped += 1;
      return;
    }
    const lsn = changeLsn(transaction.commitLsn, transaction.sequence);
    // The server restarts at a transaction boundary, so the first transaction after a resume
    // arrives whole; the rows already delivered are dropped here rather than sent twice.
    if (handlers.from !== undefined && lsn <= handlers.from) {
      this.#replayed += 1;
      return;
    }
    const before = toRow(relation, oldTuple);
    const after = toRow(relation, newTuple);
    const event: ChangeEvent = {
      entity: relation.name,
      op,
      before,
      after,
      lsn,
      txid: transaction.xid.toString(10),
      orgId: tenantOf(after ?? before),
      at: transaction.commitAt,
    };
    await handlers.onChange(event);
    this.#lastLsn = lsn;
    this.#delivered += 1;
  }

  /**
   * Tell the walsender how far we got. Serialized behind one chain because the timer and the read
   * loop both reach it, and two interleaved writes would frame one another's bytes.
   */
  async #confirm(connection: PgConnection | null = this.#connection): Promise<void> {
    if (connection === null || !connection.inCopyBoth) return;
    const position = this.#confirmed;
    const at = epochMsToPgTimestamp(this.#clock.now().getTime());
    const payload = new ByteWriter(34)
      .uint8(STANDBY_STATUS)
      .int64(position)
      .int64(position)
      .int64(position)
      .int64(at)
      .uint8(0)
      .finish();
    this.#writing = this.#writing.then(
      () => connection.sendCopyData(payload),
      () => undefined,
    );
    await this.#writing;
  }
}

/**
 * The three misconfigurations that produce an unreadable server message if left to the server.
 * `slot` and `publication` are interpolated into simple queries, so the `IDENTIFIER` charset is the
 * injection boundary; re-asserted here rather than trusted, so the guarantee travels with the
 * function instead of living only in `start()`.
 */
async function preflight(
  connection: PgConnection,
  slot: string,
  publication: string,
): Promise<void> {
  assertIdentifier('slot', slot);
  assertIdentifier('publication', publication);
  const [walLevel] = await connection.query('SHOW wal_level');
  if (walLevel?.[0] !== 'logical') {
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `wal_level is "${walLevel?.[0] ?? 'unknown'}", so the server writes no logical WAL`,
      fix: "ALTER SYSTEM SET wal_level = 'logical'; -- then restart postgres",
    });
  }
  const publications = await connection.query(
    `SELECT 1 FROM pg_publication WHERE pubname = '${publication}'`,
  );
  if (publications.length === 0) {
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `no publication named "${publication}" exists`,
      fix: `CREATE PUBLICATION ${publication} FOR ALL TABLES;`,
    });
  }
  const [existing] = await connection.query(
    `SELECT plugin FROM pg_replication_slots WHERE slot_name = '${slot}'`,
  );
  if (existing === undefined) {
    // Plain SQL rather than CREATE_REPLICATION_SLOT: the replication command exports a snapshot
    // that pins xmin for the session, and its option syntax changed in postgres 15.
    await connection.query(`SELECT pg_create_logical_replication_slot('${slot}', 'pgoutput')`);
    return;
  }
  if (existing[0] !== 'pgoutput') {
    throw new ReplicationFailedError({
      stage: 'preflight',
      detail: `slot "${slot}" decodes with "${existing[0] ?? 'unknown'}", not pgoutput`,
      fix: `SELECT pg_drop_replication_slot('${slot}'); -- then start the replicator again`,
    });
  }
}

/** A physical tuple becomes the row the matcher's predicates are written against, or nothing. */
function toRow(relation: PgRelation, physical: JsonObject | null): Row | null {
  if (physical === null) return null;
  const row = entityRow(physical);
  // A bigserial id decodes as a number inside `Number.isSafeInteger` range and as text outside it,
  // so the same table would otherwise identify small rows by number and large ones by string.
  // `Row.id`, `RowPatch.id` and every cursor are text: the identity is normalised once, here.
  const id = row['id'];
  if (typeof id === 'number' && Number.isSafeInteger(id)) row['id'] = String(id);
  if (isRow(row)) return row;
  throw new ReplicationProtocolError({
    stage: 'stream',
    detail: `table "${relation.name}" replicated a row with no text id column`,
    fix: `give ${relation.name} an id column, or drop it from the publication and the entity list`,
  });
}

/** The tenant, hoisted out of the row so fanout filters without parsing it. */
const tenantOf = (row: Row | null): string | null => {
  const orgId = row?.['orgId'];
  return typeof orgId === 'string' ? orgId : null;
};
