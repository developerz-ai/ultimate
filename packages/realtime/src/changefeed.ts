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

export type ChangeOp = 'insert' | 'update' | 'delete';

export interface ChangeEvent<R extends Row = Row> {
  /** Entity name, not table name — the matcher's dependency sets are declared in entity terms. */
  readonly entity: string;
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
}

export interface ChangeFeedStartOptions {
  /** Resume position. Omitted means "from now". */
  readonly from?: string;
  readonly onChange: (event: ChangeEvent) => void | Promise<void>;
}

export interface ChangeFeed {
  readonly source: string;
  start(options: ChangeFeedStartOptions): Promise<void>;
  stop(): Promise<void>;
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

export interface InMemoryChangeFeedOptions {
  /** Retained events, so a `start({ from })` inside the window replays instead of skipping. */
  readonly retain?: number;
}

/**
 * The blessed development and test feed. Deliveries are serialized through one promise chain:
 * ordering is the guarantee the whole pipeline is built on, so it is enforced here rather than
 * assumed downstream.
 */
export class InMemoryChangeFeed implements ChangeFeed {
  readonly source = 'in-memory';
  readonly #retained: ChangeEvent[] = [];
  readonly #retain: number;
  #handler: ChangeFeedStartOptions['onChange'] | null = null;
  #tail: Promise<void> = Promise.resolve();
  #position = 0n;
  #lastLsn: string | null = null;

  constructor(options: InMemoryChangeFeedOptions = {}) {
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
    entity: string,
    op: ChangeOp,
    rows: { before?: Row | null; after?: Row | null; orgId?: string | null; at?: number },
  ): Promise<ChangeEvent> {
    this.#position += 1n;
    const event: ChangeEvent = {
      entity,
      op,
      before: rows.before ?? null,
      after: rows.after ?? null,
      lsn: formatLsn(this.#position),
      txid: this.#position.toString(10),
      orgId: rows.orgId ?? null,
      at: rows.at ?? 0,
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
    // `lastLsn()` froze. Reachable on any single-node deployment, because `createReplicator`'s
    // `onChange` awaits `transport.publish(...)` and a closed `InProcessTransport` refuses — one
    // transient publish failure ended change delivery for the life of the process. The rejection
    // still reaches the caller that pushed THAT event, and only it; `stop()` awaits the shadow, so
    // a teardown reports the teardown rather than re-raising a failure already handed over.
    this.#tail = result.then(ignore, ignore);
    await result;
  }
}

/** Settles the shadow lane whichever way the delivery went. Nothing observes the value. */
const ignore = (): void => undefined;

export interface PgLogicalReplicationOptions {
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
}

/**
 * The production feed: `pgoutput` decoding off a logical replication slot. Everything about *how*
 * lives in `pg-replication.ts`; what this class adds is the `ChangeFeed` contract the matcher, the
 * replicator and the fanout are written against — so swapping it for `InMemoryChangeFeed` in `x dev`
 * changes nothing downstream.
 */
export class PgLogicalReplicationFeed implements ChangeFeed {
  readonly source = 'pg-logical-replication';
  readonly #stream: PgReplicationStream;

  constructor(options: PgLogicalReplicationOptions) {
    if (options.entities.length === 0) {
      throw new ReplicationFailedError({
        stage: 'preflight',
        detail: 'the feed was given an empty entity list, so no change could ever match',
        fix: 'pass the entities the publication covers: new PgLogicalReplicationFeed({ entities: [...] })',
      });
    }
    this.#stream = new PgReplicationStream(options);
  }

  async start(options: ChangeFeedStartOptions): Promise<void> {
    await this.#stream.start({ from: options.from, onChange: options.onChange });
  }

  async stop(): Promise<void> {
    await this.#stream.stop();
  }

  lastLsn(): string | null {
    return this.#stream.lastLsn();
  }

  /** Delivered / skipped / replayed counts, for `/readyz` and the `x dev` dashboard. */
  stats(): ReplicationStreamStats {
    return this.#stream.stats();
  }
}
