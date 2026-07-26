// The ordered stream of committed row changes. Production source is Postgres logical replication;
// `x dev` and every test use the in-memory feed. Both satisfy one interface, so the matcher, the
// replicator, and the fanout never learn which one they are attached to.

import { NotImplementedError } from './errors';
import type { Row } from './json';

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
    this.#retain = options.retain ?? 1024;
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
    this.#tail = this.#tail.then(async () => {
      await handler(event);
      this.#lastLsn = event.lsn;
    });
    await this.#tail;
  }
}

export interface PgLogicalReplicationOptions {
  /** `Bun.sql` connection string for a role with REPLICATION. */
  readonly url: string;
  /** Replication slot name. Exactly one `replicator` process may hold it. */
  readonly slot: string;
  readonly publication: string;
  /** Entities to decode; anything else is skipped before it reaches the matcher. */
  readonly entities: readonly string[];
}

/**
 * The production feed: `pgoutput` decoding off a logical replication slot. Interface-complete and
 * config-validated; the WAL decoder itself is milestone 6 (the reconnect benchmark) because the
 * topology is not frozen until that number is known.
 */
export class PgLogicalReplicationFeed implements ChangeFeed {
  readonly source = 'pg-logical-replication';
  readonly #options: PgLogicalReplicationOptions;

  constructor(options: PgLogicalReplicationOptions) {
    if (options.entities.length === 0) {
      throw new NotImplementedError({
        what: 'PgLogicalReplicationFeed with an empty entity list',
        fix: 'pass the entities the publication covers: new PgLogicalReplicationFeed({ entities: [...] })',
      });
    }
    this.#options = options;
  }

  async start(_options: ChangeFeedStartOptions): Promise<void> {
    throw new NotImplementedError({
      what: `pgoutput WAL decoding for slot "${this.#options.slot}"`,
      fix: 'x dev uses InMemoryChangeFeed; for Postgres run `x db replication init` (milestone 6) or set REALTIME_FEED=in-memory',
    });
  }

  async stop(): Promise<void> {
    // Nothing to release: `start` never acquired the slot.
  }

  lastLsn(): string | null {
    return null;
  }
}
