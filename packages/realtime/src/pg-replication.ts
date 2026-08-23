// Single responsibility: turn a Postgres logical-replication slot into ordered `ChangeEvent`s —
// START_REPLICATION, decode pgoutput, and keep the slot confirmed. The preflight, the connection,
// the framing and the pgoutput decode live next door; what is decided here is *ordering*, because
// the lsn is the only authority the pipeline has.

import { type Clock, logger, renderThrowable, systemClock } from '@ultimat3/core';
import type { ChangeEvent, ChangeOp, PgLogicalReplicationOptions } from './changefeed';
import { ReplicationProtocolError } from './errors';
import { isRow, type Row } from './json';
import { ByteReader, ByteWriter, epochMsToPgTimestamp, printLsn } from './pg-bytes';
import { PgConnection } from './pg-connection';
import { entityRow } from './pg-entity-row';
import { assertIdentifier, preflight } from './pg-preflight';
import { bunPgStream, parsePgUrl } from './pg-socket';
import type { PhysicalRow } from './pg-values';
import { PgOutputDecoder, type PgOutputMessage, type PgRelation } from './pgoutput';

const DEFAULT_STATUS_INTERVAL_MS = 10_000;

/**
 * Consecutive standby-status writes that may fail before the stream is declared dead.
 *
 * Three, at the default 10s interval, is 30s — inside postgres' own 60s `wal_sender_timeout`, so
 * the replicator gives up at roughly the same moment the server would. It is a constant and not an
 * option because it is a fraction of `statusIntervalMs`, and a second knob is a second number that
 * can disagree with the one it is a fraction of.
 */
const MAX_CONFIRM_FAILURES = 3;

/** `r` — the standby status update, the only frontend message a walsender listens for. */
const STANDBY_STATUS = 0x72;

export interface ReplicationStreamStats {
  readonly delivered: number;
  /** Rows for a table outside the entity list — the publication is wider than the app is. */
  readonly skipped: number;
  /** Rows replayed from before the resume position, dropped so `onChange` sees each one once. */
  readonly replayed: number;
  /**
   * Changes delivered from a relation whose replica identity is not FULL — so the `before` row is
   * the key columns alone (or absent), and the live matcher's "did this row leave the result set"
   * is decided on a partial row. `X_LIVE_REPLICA_IDENTITY` warns about the CONFIGURATION once at
   * preflight; this counts the decisions it actually cost, which is the half a running node can
   * be alerted on. Inserts never count: there is no `before` to be partial.
   */
  readonly partialBefore: number;
  /**
   * Standby-status writes that have failed in a row without one landing in between. It is the half
   * of a broken stream the delivery count cannot show: the read side goes on delivering while
   * `confirmed_flush_lsn` stops advancing, so WAL accumulates on the primary with nothing else
   * reporting it. Reset by the first confirm that lands.
   */
  readonly confirmFailures: number;
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
  readonly #slot: string;
  readonly #publication: string;
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
  #partialBefore = 0;
  #confirmFailures = 0;
  #failure: string | null = null;

  constructor(options: PgLogicalReplicationOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#entities = new Set(options.entities.map((name) => assertIdentifier('entity', name)));
    // All three names are checked here rather than in `start()`: a mistyped REPLICATION_SLOT is a
    // boot-time fact, and refusing it at the first WAL read means a replicator that reported
    // itself started and then never delivered a change.
    this.#slot = assertIdentifier('slot', options.slot);
    this.#publication = assertIdentifier('publication', options.publication);
  }

  lastLsn(): string | null {
    return this.#lastLsn;
  }

  stats(): ReplicationStreamStats {
    return {
      delivered: this.#delivered,
      skipped: this.#skipped,
      replayed: this.#replayed,
      partialBefore: this.#partialBefore,
      confirmFailures: this.#confirmFailures,
      failure: this.#failure,
    };
  }

  /** Resolves once the stream is live. Delivery continues on the pump until `stop()`. */
  async start(handlers: ReplicationStreamHandlers): Promise<void> {
    if (this.#running) return;
    // `#pump` is the previous run's *terminal cleanup*, not just its read loop: `#drain` awaits
    // `#die`, and `#die` awaits `connection.close()`. `#die` clears `#running` and nulls
    // `#connection` before that close settles, so a restart that dialled here would replace
    // `#pump` with its own and leave the old walsender holding the slot — the next `stop()` would
    // await only the new pump and report a released slot to a supervisor whose next process then
    // collides with one that is still `active`. Waiting for it is waiting for the prior teardown.
    const previous = this.#pump;
    this.#pump = null;
    if (previous !== null) await previous;
    const slot = this.#slot;
    const publication = this.#publication;
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
      await preflight(connection, slot, publication, this.#entities);
      const from = handlers.from;
      this.#confirmed = from === undefined ? 0n : commitPositionOf(from);
      await connection.startCopyBoth(
        `START_REPLICATION SLOT ${slot} LOGICAL ${printLsn(this.#confirmed)} ` +
          `(proto_version '1', publication_names '${publication}')`,
      );
    } catch (failure) {
      // The dial failure is the one that explains the boot, so a teardown that also failed must
      // not replace it — `stop()` has released everything either way by the time it rethrows.
      await this.stop().catch(() => undefined);
      throw failure;
    }
    this.#running = true;
    // A restart that kept the last death in `stats()` reports a live stream as failed, and the
    // supervisor that reads it never sees the replicator come back.
    this.#failure = null;
    this.#confirmFailures = 0;
    this.#timer = setInterval(() => {
      void this.#confirmOnTimer();
    }, this.#options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS);
    // A pending timer must not be what keeps `x dev` alive after the app is done with it.
    this.#timer.unref?.();
    this.#pump = this.#drain(connection, handlers);
  }

  /**
   * Every step here runs whatever the step before it did. A `#confirm` or an `endCopy` that threw
   * used to skip the close and the pump await entirely: the socket leaked, the slot stayed
   * `active`, and `stop()` reported the failure to a supervisor that was already starting the next
   * process — teardown announced as finished before it had begun. The first failure is the one
   * that explains the shutdown, so it is the one rethrown, and only once everything is let go.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#clearTimer();
    const connection = this.#connection;
    this.#connection = null;
    const failures: unknown[] = [];
    try {
      // Confirming before the goodbye is what stops a restart from replaying the whole window.
      if (connection?.inCopyBoth === true) {
        await this.#confirm(connection);
        await connection.endCopy();
      }
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await connection?.close();
    } catch (failure) {
      failures.push(failure);
    }
    // Awaited even when the stream died on its own: `#die` nulls the connection *before* closing
    // it, so returning here would report the socket as released while it is still going down.
    const pump = this.#pump;
    this.#pump = null;
    try {
      if (pump !== null) await pump;
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 0) throw failures[0];
  }

  /**
   * The pump's only way out, however it ended — a decode error, or a walsender that said goodbye.
   * The four things it owns go together or not at all, because each one left behind is a dead
   * replicator claiming to be a live one: a `null` failure for a loop that stopped reading, a
   * confirm timer still telling the walsender the stream is keeping up, a socket nobody closed,
   * and a `#connection` the next `start()` overwrites instead of releasing. A `stop()` that got
   * here first owns the connection, and its exit is an orderly one, not a failure.
   */
  async #die(reason: string): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#failure = reason;
    this.#clearTimer();
    const connection = this.#connection;
    this.#connection = null;
    // The supervisor reads /readyz, so the loop records, reports and ends rather than throwing
    // into a promise nothing awaits.
    logger.error('replication stream ended', { slot: this.#options.slot, error: reason });
    try {
      await connection?.close();
    } catch {
      // The socket is already unusable and `failure` above is the report that matters — a
      // goodbye that throws must not become the rejection `#drain` promised never to produce.
    }
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The read loop. It owns no timers and no state beyond the current transaction. */
  async #drain(connection: PgConnection, handlers: ReplicationStreamHandlers): Promise<void> {
    try {
      for (;;) {
        const payload = await connection.nextCopyData();
        if (payload === undefined) {
          // The walsender ended the copy. However politely it said so, nothing reads the slot
          // again until something restarts this — which is a failure, not a shutdown.
          await this.#die('the walsender ended the copy stream');
          return;
        }
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
      await this.#die(renderThrowable(failure));
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
    oldTuple: PhysicalRow | null,
    newTuple: PhysicalRow | null,
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
    // Read off the Relation message rather than off the tuple: a DEFAULT-identity table whose
    // non-key columns happen to be NULL sends the same bytes a FULL one does, so counting missing
    // keys would undercount exactly the rows a policy is most likely to misjudge.
    if (op !== 'insert' && relation.replicaIdentity !== 'f') this.#partialBefore += 1;
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
   * The TIMER's confirm, and the one call that may not reject. `void this.#confirm()` handed the
   * rejection to nobody: `#confirm` awaits `#writing`, which rejects the moment the socket is gone,
   * and no package in this repo installs an `unhandledRejection` handler, so Bun ends the process —
   * an uncoded `TypeError` reaching the operator with no code and no `fix:`, and exit code 1 on an
   * otherwise clean shutdown.
   *
   * Worse than the crash was the silence before it: `stats().failure` stayed `null`, so `/readyz`
   * reported the replicator live while `confirmed_flush_lsn` stopped advancing and WAL piled up on
   * the primary. A run of failures is now a death, the same way `#drain`'s catch is — the four
   * things `#die` owns go together or not at all.
   */
  async #confirmOnTimer(): Promise<void> {
    try {
      await this.#confirm();
      // Consecutive, not cumulative: one confirm that lands means the walsender is being told
      // where we are, and a lifetime count would eventually kill a healthy stream.
      this.#confirmFailures = 0;
    } catch (failure) {
      this.#confirmFailures += 1;
      logger.warn('replication confirm failed', {
        slot: this.#options.slot,
        consecutive: this.#confirmFailures,
        error: renderThrowable(failure),
      });
      const consecutive = this.#confirmFailures;
      if (consecutive >= MAX_CONFIRM_FAILURES) {
        await this.#die(
          `${consecutive} standby status updates failed in a row — ` +
            `the slot is not being confirmed: ${renderThrowable(failure)}`,
        );
      }
    }
  }

  /**
   * Tell the walsender how far we got. Serialized behind one chain because the timer and the read
   * loop both reach it, and two interleaved writes would frame one another's bytes.
   *
   * It still RAISES: `stop()` and the keepalive reply both await it and both need the answer. Only
   * the timer, which awaits nothing, goes through `#confirmOnTimer` above.
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
    // The chain SERIALIZES writes; it does not decide them. Putting the rejection handler on the
    // chain itself meant the confirm after a failed one resolved without writing anything —
    // `.then(send, () => undefined)` runs the second handler and hands back its `undefined`, so
    // every other standby status update after the first failure was a no-op that reported success.
    // A run of failures could then never be seen, because the run never got past one.
    const attempt = this.#writing.then(() => connection.sendCopyData(payload));
    // What the NEXT caller queues behind is this attempt settled either way; what THIS caller
    // awaits is the attempt itself, because it is the only one entitled to its outcome.
    this.#writing = attempt.catch(() => undefined);
    await attempt;
  }
}

/** A physical tuple becomes the row the matcher's predicates are written against, or nothing. */
function toRow(relation: PgRelation, physical: PhysicalRow | null): Row | null {
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
