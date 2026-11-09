// Single responsibility: turn a Postgres logical-replication slot into ordered `ChangeEvent`s —
// START_REPLICATION, decode pgoutput, and keep the slot confirmed. The preflight, the connection,
// the framing and the pgoutput decode live next door; what is decided here is *ordering*, because
// the lsn is the only authority the pipeline has.

import { type Clock, finiteOption, logger, renderThrowable, systemClock } from '@ultimat3/core';
import type { ChangeEvent, ChangeOp, PostgresChangeFeedOptions } from './changefeed';
import { ReplicationProtocolError } from './errors';
import { ByteReader } from './pg-bytes';
import type { PgConnection } from './pg-connection';
import { assertIdentifier } from './pg-identifier';
import { dialReplication, type SlotGap } from './pg-replication-dial';
import {
  type ConfirmAttempt,
  StreamLiveness,
  silenceReason,
  unsettledReason,
} from './pg-replication-liveness';
import { changeLsn, standbyStatus } from './pg-replication-position';
import { replicatedImages, tenantOf } from './pg-replication-row';
import type { ReplicationStreamStats } from './pg-replication-stats';
import type { PhysicalRow } from './pg-values';
import { keyedWrite, PgOutputDecoder, type PgOutputMessage, type PgRelation } from './pgoutput';

// Moved next door; their importers (`server.ts`, `changefeed.ts`, the tests) keep this path.
export { changeLsn, commitPositionOf } from './pg-replication-position';
export type { ReplicationStreamStats } from './pg-replication-stats';

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

interface Transaction {
  readonly commitLsn: bigint;
  readonly commitAt: number;
  readonly xid: number;
  /** Position of the next row inside this transaction. Reproducible, which is what makes it usable. */
  sequence: number;
  /** The keyed write this transaction is (`ChangeEvent.write`), from its opening WAL message. */
  write?: string | undefined;
}

export interface ReplicationStreamHandlers {
  readonly from?: string | undefined;
  onChange(event: ChangeEvent): void | Promise<void>;
  /** Called once when the pump dies on its own; never for a `stop()`. */
  readonly onEnd?: ((reason: string) => void) | undefined;
  /** The stream is continuous no more — its slot was recreated under `from` — so re-read all. */
  readonly onResync?: ((reason: string) => void) | undefined;
}

/**
 * One slot, one connection, one process. Started by `PostgresChangeFeed`, which is itself
 * held by the single `replicator` role — the advisory lock upstream is what keeps that "one" true.
 */
export class PgReplicationStream {
  readonly #options: PostgresChangeFeedOptions;
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
  readonly #liveness = new StreamLiveness();
  /** A slot created under `from` by a dial that has not yet got through (`SlotGap`). */
  readonly #slotGap: SlotGap = { createdUnder: null };
  #intervalMs = DEFAULT_STATUS_INTERVAL_MS;
  #onEnd: ((reason: string) => void) | undefined;

  constructor(options: PostgresChangeFeedOptions) {
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
    // `#pump` is the previous run's TERMINAL CLEANUP (`#die` awaits `close()`): dialling before it
    // settles leaves the old walsender holding the slot while `stop()` reports it released. A
    // destroyed run has no cleanup left to wait for (`#letPumpGo`).
    const previous = this.#pump;
    this.#pump = null;
    if (previous !== null) await previous;
    const names = { slot: this.#slot, publication: this.#publication, entities: this.#entities };
    const dialed = await dialReplication(this.#options, names, handlers.from, this.#slotGap);
    const connection = dialed.connection;
    this.#connection = connection;
    this.#confirmed = dialed.confirmed;
    this.#running = true;
    // A restart that kept the last death in `stats()` would report a live stream as failed.
    this.#failure = null;
    this.#confirmFailures = 0;
    this.#onEnd = handlers.onEnd;
    this.#liveness.reset();
    // A confirm the last run parked on a dead socket never settles: queued behind it, every
    // confirm of this run would park too, and the slot would never be confirmed again.
    this.#writing = Promise.resolve();
    this.#intervalMs = finiteOption(
      'the replication stream',
      'statusIntervalMs',
      this.#options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS,
    );
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    // A pending timer must not be what keeps `x dev` alive after the app is done with it.
    this.#timer.unref?.();
    this.#pump = this.#drain(connection, { ...handlers, from: dialed.from });
    // Before the first change of the new slot can reach anyone: every reader re-reads NOW, rather
    // than a quiet table staying stale until its next write.
    if (dialed.resync !== null) handlers.onResync?.(dialed.resync);
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
   * `stop()` without the goodbye: no confirm, no `CopyDone`, no `Terminate`, nothing awaited — on a
   * black-holed walsender each of those is a write nothing settles. The unconfirmed tail is
   * re-sent to the next stream and dropped by its `from`.
   */
  abandon(): void {
    this.#running = false;
    this.#onEnd = undefined;
    this.#clearTimer();
    const connection = this.#connection;
    this.#connection = null;
    connection?.destroy();
    this.#letPumpGo();
  }

  /**
   * After a DESTROY the teardown is done, but the pump may be parked on a read a half-open socket
   * never ends. Nothing waits on it; `#drain`'s connection fence keeps it off the next run.
   */
  #letPumpGo(): void {
    this.#pump = null;
  }

  /**
   * The pump's only way out, however it ended — a decode error, or a walsender that said goodbye.
   * The four things it owns go together or not at all, because each one left behind is a dead
   * replicator claiming to be a live one: a `null` failure for a loop that stopped reading, a
   * confirm timer still telling the walsender the stream is keeping up, a socket nobody closed,
   * and a `#connection` the next `start()` overwrites instead of releasing. A `stop()` that got
   * here first owns the connection, and its exit is an orderly one, not a failure.
   */
  async #die(reason: string, goodbye: 'close' | 'destroy' = 'close'): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#failure = reason;
    this.#clearTimer();
    const connection = this.#connection;
    this.#connection = null;
    // The loop records, reports and ends rather than throwing into a promise nothing awaits.
    logger.error('replication stream ended', { slot: this.#options.slot, error: reason });
    // A liveness death DESTROYS: the far end is not answering, and a `Terminate` written into it
    // is a write nothing settles — `#die` would park there and never reach `onEnd`.
    if (goodbye === 'destroy') {
      connection?.destroy();
      this.#letPumpGo();
    }
    try {
      if (goodbye === 'close') await connection?.close();
    } catch {
      // The socket is already unusable and `failure` above is the report that matters — a
      // goodbye that throws must not become the rejection `#drain` promised never to produce.
    }
    // Last, so whoever restarts finds the socket already let go. Called, never awaited.
    const onEnd = this.#onEnd;
    this.#onEnd = undefined;
    try {
      onEnd?.(reason);
    } catch (failure) {
      logger.error('replication onEnd listener threw', { error: renderThrowable(failure) });
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
        this.#liveness.awaitingRead();
        const payload = await connection.nextCopyData();
        // A run that was let go — `stop()`, `abandon()`, a liveness death — ends here: nothing it
        // reads afterwards is this stream's, and its `#die` would end the NEXT run.
        if (this.#connection !== connection) return;
        this.#liveness.heard();
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
      if (this.#connection !== connection) return;
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
      case 'message':
        // The driver's first statement in a keyed write: every row after it is that write's.
        if (this.#transaction !== null) this.#transaction.write ??= keyedWrite(message);
        return;
      case 'commit':
        this.#transaction = null;
        if (message.endLsn > this.#confirmed) this.#confirmed = message.endLsn;
        return;
      case 'insert':
        await this.#deliver('insert', message.relation, null, message.after, [], handlers);
        return;
      case 'update': {
        const { relation, before, after, unchanged } = message;
        await this.#deliver('update', relation, before, after, unchanged, handlers);
        return;
      }
      case 'delete':
        await this.#deliver('delete', message.relation, message.before, null, [], handlers);
        return;
      case 'truncate':
        // One change per truncated relation, rowless. It was decoded and DROPPED here, and with the
        // recommended `FOR ALL TABLES` publication every window and every client kept the rows.
        for (const relation of message.relations) {
          await this.#deliver('truncate', relation, null, null, [], handlers);
        }
        return;
      default:
        // Relation, origin, type, logical message: nothing the matcher can act on.
        return;
    }
  }

  async #deliver(
    op: ChangeOp,
    relation: PgRelation,
    oldTuple: PhysicalRow | null,
    newTuple: PhysicalRow | null,
    unchanged: readonly string[],
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
    if ((op === 'update' || op === 'delete') && relation.replicaIdentity !== 'f') {
      this.#partialBefore += 1;
    }
    const { before, after, omitted } = replicatedImages(relation, oldTuple, newTuple, unchanged);
    const event: ChangeEvent = {
      table: relation.name,
      op,
      before,
      after,
      lsn,
      txid: transaction.xid.toString(10),
      orgId: tenantOf(after ?? before),
      at: transaction.commitAt,
      write: transaction.write ?? null,
      ...(omitted.length === 0 ? {} : { omitted }),
    };
    await handlers.onChange(event);
    this.#lastLsn = lsn;
    this.#delivered += 1;
  }

  /** One status interval: the read deadline, then the confirm (`pg-replication-liveness.ts`). */
  #tick(): void {
    // Silence first: a half-open socket accepts every write, so no confirm ever fails on one.
    if (this.#liveness.silentTooLong()) {
      void this.#die(silenceReason(this.#intervalMs), 'destroy');
      return;
    }
    void this.#confirmOnTimer();
  }

  /**
   * The TIMER's confirm, and the one call that may not reject: nothing awaits it, and an unhandled
   * rejection ends the Bun process uncoded. A run of failures — rejected, or still unsettled at the
   * next interval — is a death instead, so `stats().failure` and `/readyz` see a slot that is not
   * being confirmed while WAL piles up on the primary.
   */
  async #confirmOnTimer(): Promise<void> {
    const connection = this.#connection;
    if (connection === null) return;
    const attempt: ConfirmAttempt | null = this.#liveness.begin();
    if (attempt === null) {
      // The last interval's write is still on the wire: that is this interval's failure.
      this.#confirmFailures += 1;
      const unsettled = this.#confirmFailures;
      logger.warn('replication confirm unsettled', { slot: this.#options.slot, unsettled });
      if (unsettled >= MAX_CONFIRM_FAILURES) {
        await this.#die(unsettledReason(unsettled, this.#intervalMs), 'destroy');
      }
      return;
    }
    try {
      await this.#confirm(connection, true);
      if (this.#connection !== connection) return;
      // Consecutive, not cumulative: one confirm that lands means the walsender is being told
      // where we are, and a lifetime count would eventually kill a healthy stream.
      this.#confirmFailures = 0;
    } catch (failure) {
      // A write from a run that already ended is not this run's failure.
      if (this.#connection !== connection) return;
      this.#confirmFailures += 1;
      logger.warn('replication confirm failed', {
        slot: this.#options.slot,
        consecutive: this.#confirmFailures,
        error: renderThrowable(failure),
      });
      const consecutive = this.#confirmFailures;
      if (consecutive >= MAX_CONFIRM_FAILURES)
        await this.#die(
          `${consecutive} standby status updates failed in a row — ` +
            `the slot is not being confirmed: ${renderThrowable(failure)}`,
        );
    } finally {
      this.#liveness.settle(attempt);
    }
  }

  /**
   * Tell the walsender how far we got. Serialized behind one chain because the timer and the read
   * loop both reach it, and two interleaved writes would frame one another's bytes.
   *
   * It still RAISES: `stop()` and the keepalive reply both await it and both need the answer. Only
   * the timer, which awaits nothing, goes through `#confirmOnTimer` above.
   */
  async #confirm(
    connection: PgConnection | null = this.#connection,
    requestReply = false,
  ): Promise<void> {
    if (connection === null || !connection.inCopyBoth) return;
    const payload = standbyStatus(this.#confirmed, this.#clock.now().getTime(), requestReply);
    // The chain SERIALIZES writes; it does not decide them. A rejection handler on the chain itself
    // (`.then(send, () => undefined)`) made every update after a failed one a no-op reporting
    // success, so a run of failures could never be seen.
    const attempt = this.#writing.then(() => connection.sendCopyData(payload));
    // What the NEXT caller queues behind is this attempt settled either way; what THIS caller
    // awaits is the attempt itself, because it is the only one entitled to its outcome.
    this.#writing = attempt.catch(() => undefined);
    await attempt;
  }
}
