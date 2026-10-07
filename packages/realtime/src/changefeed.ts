// The ordered stream of committed row changes. Production source is Postgres logical replication;
// `x dev` and every test use the in-memory feed. Both satisfy one interface, so the matcher, the
// replicator, and the fanout never learn which one they are attached to.

import type { Clock } from '@ultimat3/core';
import { finiteOption } from '@ultimat3/core';
import { ReplicationFailedError } from './errors';
import type { Row } from './json';
import { PgReplicationStream, type ReplicationStreamStats } from './pg-replication';
import type { PgTarget } from './pg-socket';
import type { PgStream } from './pg-wire';
import type { Rng } from './thundering-herd';

/**
 * `truncate` carries no row — `before` and `after` are both `null` — and means every row of the
 * relation is gone. A window cannot be patched from it, only re-read; a channel's members are told
 * to re-read (`replay-gap`). It was decoded and dropped, so with the recommended `FOR ALL TABLES`
 * publication every window and every client kept the truncated rows forever.
 */
export type ChangeOp = 'insert' | 'update' | 'delete' | 'truncate';

export interface ChangeEvent<R extends Row = Row> {
  /**
   * The RELATION (table) name, on every producer: the WAL decoder reads it off the Relation
   * message, the in-process bridge maps the row observer's entity name onto it, and a
   * `recordPublisher` sends `projection.table`. A channel matches `projection.table`, a live shape
   * is `from('<table>', …)`; the record TYPE (entity name) is derived from it (`recordTypeForTable`).
   */
  readonly table: string;
  readonly op: ChangeOp;
  readonly before: R | null;
  readonly after: R | null;
  /** Lexicographically comparable position. Use `formatLsn` / `parseLsn`, never a raw pg string. */
  readonly lsn: string;
  readonly txid: string;
  /** Tenant column, hoisted out of the row so fanout can filter without parsing it. */
  readonly orgId: string | null;
  /** Commit time, epoch ms. */
  readonly at: number;
  /**
   * The write that made this change: `writeDigest` of the idempotency key its request carried
   * (`@ultimat3/core`). `null` for a change no keyed request made — a job, a script, raw SQL. Read
   * off the WAL message the Postgres driver writes first in the transaction, or off the request
   * scope in-process; a channel stamps it on its `records` frame and a live query on its `patch`
   * frame, so the writing page settles its own echo in the same batch. REQUIRED, never optional:
   * a producer that forgets it is a type error, not a page that paints truth plus overlay.
   */
  readonly write: string | null;
  /**
   * Row properties `after` does NOT carry because Postgres did not log them: an UPDATE that left
   * an out-of-line (TOAST) value untouched sends no bytes for it, and under any replica identity
   * but FULL there is no old image to read it from. Absent when `after` is the whole row. A
   * consumer must not adopt `after` as the row while this is set — it re-reads instead.
   */
  readonly omitted?: readonly string[];
}

export interface ChangeFeedStartOptions {
  /** Resume position. Omitted means "from now". */
  readonly from?: string;
  readonly onChange: (event: ChangeEvent) => void | Promise<void>;
  /**
   * The feed stopped delivering ON ITS OWN — the walsender ended the copy, a decode failed, the
   * handler rejected — and will not resume until `start()` is called again. Never called for a
   * `stop()`. This is the only way out a pump has: nothing awaits its read loop, so a death that
   * was only recorded was a death nobody saw.
   */
  readonly onEnd?: (reason: string) => void;
}

export interface ChangeFeed {
  readonly source: string;
  start(options: ChangeFeedStartOptions): Promise<void>;
  stop(): Promise<void>;
  /**
   * Go silent NOW, without asking: synchronous, nothing written, nothing awaited. For a stream
   * that may already be dead — `stop()` says goodbye first, and a goodbye to a black-holed socket
   * is never answered. After it returns no further change is delivered and `onEnd` is not called.
   */
  abandon(): void;
  /** Highest lsn delivered to the handler; the replicator persists this to survive a restart. */
  lastLsn(): string | null;
}

/** 16-hex zero-padded so string comparison equals numeric comparison. */
export function formatLsn(position: bigint | number): string {
  return BigInt(position).toString(16).padStart(16, '0');
}

/** Postgres prints LSNs as `0/16B3748`. Both halves are hex; join them into one sortable value. */
export function parseLsn(pgLsn: string): string {
  const [high = '0', low = '0'] = pgLsn.split('/');
  return formatLsn((BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`));
}

export interface MemoryChangeFeedOptions {
  /** Retained events, so a `start({ from })` inside the window replays instead of skipping. */
  readonly retain?: number;
}

/**
 * The blessed development and test feed. Deliveries are serialized through one promise chain:
 * ordering is the guarantee the whole pipeline is built on, so it is enforced here rather than
 * assumed downstream.
 */
export class MemoryChangeFeed implements ChangeFeed {
  readonly source = 'in-memory';
  readonly #retained: ChangeEvent[] = [];
  readonly #retain: number;
  #handler: ChangeFeedStartOptions['onChange'] | null = null;
  #tail: Promise<void> = Promise.resolve();
  #position = 0n;
  #lastLsn: string | null = null;

  constructor(options: MemoryChangeFeedOptions = {}) {
    this.#retain = finiteOption('the change feed', 'retain', options.retain ?? 1024);
  }

  async start(options: ChangeFeedStartOptions): Promise<void> {
    this.#handler = options.onChange;
    const from = options.from;
    if (from === undefined) return;
    for (const event of this.#retained) {
      if (event.lsn > from) await this.#deliver(event);
    }
  }

  async stop(): Promise<void> {
    this.#handler = null;
    await this.#tail;
  }

  abandon(): void {
    this.#handler = null;
  }

  lastLsn(): string | null {
    return this.#lastLsn;
  }

  /** Append a fully-formed event. Used by tests that need an exact lsn or txid. */
  async emit(event: ChangeEvent): Promise<void> {
    if (this.#retain > 0) {
      this.#retained.push(event);
      while (this.#retained.length > this.#retain) this.#retained.shift();
    }
    await this.#deliver(event);
  }

  /** Ergonomic emit: assigns the next lsn and txid so tests read as domain events. */
  async push(
    table: string,
    op: ChangeOp,
    rows: {
      before?: Row | null;
      after?: Row | null;
      orgId?: string | null;
      at?: number;
      write?: string | null;
    },
  ): Promise<ChangeEvent> {
    this.#position += 1n;
    const event: ChangeEvent = {
      table,
      op,
      before: rows.before ?? null,
      after: rows.after ?? null,
      lsn: formatLsn(this.#position),
      txid: this.#position.toString(10),
      orgId: rows.orgId ?? null,
      at: rows.at ?? 0,
      write: rows.write ?? null,
    };
    await this.emit(event);
    return event;
  }

  async #deliver(event: ChangeEvent): Promise<void> {
    const handler = this.#handler;
    if (!handler) return;
    const result = this.#tail.then(async () => {
      await handler(event);
      this.#lastLsn = event.lsn;
    });
    // The lane chains on a SETTLED shadow, never on `result` — `window-lock.ts` solves the same
    // problem the same way. Chained on the live tail, one rejected link poisoned every link behind
    // it: later changes rejected with the FIRST error, the handler was never called again and
    // `lastLsn()` froze. Reachable on any single-node deployment, because `changeFeedReplicator`'s
    // `onChange` awaits `transport.publish(...)` and a closed `InProcessTransport` refuses — one
    // transient publish failure ended change delivery for the life of the process. The rejection
    // still reaches the caller that pushed THAT event, and only it; `stop()` awaits the shadow, so
    // a teardown reports the teardown rather than re-raising a failure already handed over.
    this.#tail = result.then(ignore, ignore);
    await result;
  }
}

/** The one way to build the in-process feed — the twin of `postgresChangeFeed()`; the class is a type in the barrel only (`X_FACTORY_NAME_SPELLING`). */
export function memoryChangeFeed(options: MemoryChangeFeedOptions = {}): MemoryChangeFeed {
  return new MemoryChangeFeed(options);
}

/** Settles the shadow lane whichever way the delivery went. Nothing observes the value. */
const ignore = (): void => undefined;

export interface PostgresChangeFeedOptions {
  /** Connection string for a role with REPLICATION: `postgres://user:pass@host:5432/db`. */
  readonly url: string;
  /** Replication slot name. Exactly one `replicator` process may hold it. */
  readonly slot: string;
  readonly publication: string;
  /** Entities to decode; anything else is skipped before it reaches the matcher. */
  readonly entities: readonly string[];
  /** How often the slot is confirmed. Longer means more WAL retained after a crash. */
  readonly statusIntervalMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Injected so the SCRAM nonce is deterministic under a seeded test. */
  readonly rng?: Rng | undefined;
  /** The byte pipe, injected. Defaults to `Bun.connect`; a test drives a scripted server instead. */
  readonly stream?: ((target: PgTarget) => Promise<PgStream>) | undefined;
  /**
   * Tables whose DELETE must carry the whole old row — a channel with params routes a removal by
   * columns only `REPLICA IDENTITY FULL` logs. Preflight warns for each that is not FULL. Defaults
   * to what the declared channels need (`pg-identity-tables.ts`).
   */
  readonly fullIdentityTables?: readonly string[] | undefined;
}

/**
 * The production feed: `pgoutput` decoding off a logical replication slot. Everything about *how*
 * lives in `pg-replication.ts`; what this class adds is the `ChangeFeed` contract the matcher, the
 * replicator and the fanout are written against — so swapping it for `MemoryChangeFeed` in `x dev`
 * changes nothing downstream.
 */
export class PostgresChangeFeed implements ChangeFeed {
  readonly source = 'pg-logical-replication';
  readonly #stream: PgReplicationStream;

  constructor(options: PostgresChangeFeedOptions) {
    if (options.entities.length === 0) {
      throw new ReplicationFailedError({
        stage: 'preflight',
        detail: 'the feed was given an empty entity list, so no change could ever match',
        fix: 'pass the entities the publication covers: postgresChangeFeed({ entities: [...] })',
      });
    }
    this.#stream = new PgReplicationStream(options);
  }

  async start(options: ChangeFeedStartOptions): Promise<void> {
    await this.#stream.start({
      from: options.from,
      onChange: options.onChange,
      onEnd: options.onEnd,
    });
  }

  async stop(): Promise<void> {
    await this.#stream.stop();
  }

  abandon(): void {
    this.#stream.abandon();
  }

  lastLsn(): string | null {
    return this.#stream.lastLsn();
  }

  /** Delivered / skipped / replayed counts, for `/readyz` and the `x dev` dashboard. */
  stats(): ReplicationStreamStats {
    return this.#stream.stats();
  }
}

/** The one way to build the WAL-backed feed — the twin of `memoryChangeFeed()`; the class is a type in the barrel only (`X_FACTORY_NAME_SPELLING`). */
export function postgresChangeFeed(options: PostgresChangeFeedOptions): PostgresChangeFeed {
  return new PostgresChangeFeed(options);
}
