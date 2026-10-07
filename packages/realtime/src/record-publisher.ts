// Committed rows an app hands over → change envelopes on the subject every sync node reads, for a
// deployment that runs no replicator. Channels only: a publisher has no commit position, so its
// changes feed the declared channels and never a live window (`sync-bus-handlers.ts`). One per
// process, built at boot: it is one producer, and its seq is what a node sees a lost message in.

import {
  assert,
  type Clock,
  currentWriteOrigin,
  isWriteDigest,
  systemClock,
  uuidV7,
} from '@ultimat3/core';
import { type RecordProjection, recordProjection } from '@ultimat3/entity/record';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { ChannelEntity } from './channel-decl';
import type { Transport } from './fanout';
import type { Row } from './json';
import { changeSubject } from './replicator';
import { encodeEnvelope } from './replicator-envelope';

export interface RecordPublisherOptions {
  readonly transport: Transport;
  /**
   * Every entity this process publishes, claimed until `close()`. Claimed, `x dev`'s in-process
   * bridge stops carrying that entity's repository writes to channels — the app's publish is then
   * the one delivery, exactly as it is in production with no replicator.
   */
  readonly entities: readonly ChannelEntity[];
  /** Tenant column, hoisted into the subject as the replicator hoists it. Default `orgId`. */
  readonly tenantColumn?: string;
  readonly clock?: Clock;
}

export interface PublishOptions {
  /** `upsert` (default): the rows are adopted. `delete`: the rows are gone, by their key. */
  readonly op?: 'upsert' | 'delete';
  /**
   * The keyed write these rows belong to — `writeDigest(idempotencyKey)` — so the page that made
   * it settles its own echo. Default: the keyed request this call runs inside, else `null`.
   */
  readonly write?: string | null;
}

export interface RecordPublisher extends Disposable {
  /** This publisher's producer id: the stream its `seq` counts in. */
  readonly producer: string;
  /**
   * Put COMMITTED rows on the bus, one change per row, in call order. Call it after the
   * transaction commits: a row published from inside one is on every page before a rollback.
   * Rejects with the first refusal once every row was tried; a refused row's seq stays spent, so
   * every node reads the hole and its channel members re-run their catch-up read.
   */
  publish(
    entity: ChannelEntity,
    rows: readonly Readonly<Record<string, unknown>>[],
    options?: PublishOptions,
  ): Promise<void>;
  /** Releases the claim. Idempotent; a closed publisher refuses to publish. */
  close(): void;
}

/** Tables a live publisher claims, counted: two publishers may claim one. */
const claims = new Map<string, number>();

/**
 * Whether a `recordPublisher` in this process claims `table` — the relation, the vocabulary of
 * `ChangeEvent.table` on every producer.
 */
export function isPublishedTable(table: string): boolean {
  return claims.has(table);
}

export function recordPublisher(options: RecordPublisherOptions): RecordPublisher {
  const clock = options.clock ?? systemClock;
  const tenant = options.tenantColumn ?? 'orgId';
  const projections = new Map<string, RecordProjection>();
  for (const declared of options.entities) {
    const projection = recordProjection(declared);
    projections.set(projection.type, projection);
  }
  const names = [...projections.values()].map((projection) => projection.table);
  for (const name of names) claims.set(name, (claims.get(name) ?? 0) + 1);
  const producer = uuidV7();
  let seq = 0;
  let open = true;
  // One chain, so seq order is bus order whatever the caller awaits: a node reads a seq that
  // arrives out of order as a hole that was never there.
  let tail: Promise<unknown> = Promise.resolve();

  const close = (): void => {
    if (!open) return;
    open = false;
    for (const name of names) {
      const held = (claims.get(name) ?? 1) - 1;
      if (held > 0) claims.set(name, held);
      else claims.delete(name);
    }
  };

  const changeOf = (
    projection: RecordProjection,
    row: Readonly<Record<string, unknown>>,
    op: 'upsert' | 'delete',
    write: string | null,
  ): ChangeEvent => {
    // The record's own properties and nothing else: the entity's record schema omits every sealed
    // column, so neither a secret nor a property the entity never declared can ride.
    const columns = projection.schema.properties ?? {};
    const image = Object.fromEntries(
      Object.entries(row).filter(([property]) => Object.hasOwn(columns, property)),
    ) as Row;
    // Refused here, before any row of the call is sequenced: a keyless row matches no record.
    projection.key(image);
    const orgId = image[tenant];
    return {
      table: projection.table,
      op: op === 'delete' ? 'delete' : 'update',
      before: op === 'delete' ? image : null,
      after: op === 'delete' ? null : image,
      // Stamped with the seq at send: it orders nothing outside this producer, which is why no
      // live window is fed one.
      lsn: '',
      txid: producer,
      orgId: typeof orgId === 'string' ? orgId : null,
      at: clock.now().getTime(),
      write,
    };
  };

  const send = async (change: ChangeEvent): Promise<void> => {
    seq += 1;
    await options.transport.publish(
      changeSubject(change),
      encodeEnvelope({ ...change, lsn: formatLsn(seq) }, seq, producer, 'publisher'),
    );
  };

  const publish: RecordPublisher['publish'] = async (entity, rows, publishOptions = {}) => {
    assert(
      open,
      `recordPublisher ${producer} was closed and published "${entity.$name}" after it`,
      'build one recordPublisher per process at boot and close it at shutdown',
    );
    const projection = projections.get(entity.$name);
    assert(
      projection !== undefined,
      `recordPublisher was asked to publish "${entity.$name}", which it did not claim`,
      `add ${entity.$name} to recordPublisher({ entities: [...] }) where the publisher is built`,
    );
    const write =
      publishOptions.write === undefined ? (currentWriteOrigin() ?? null) : publishOptions.write;
    assert(
      write === null || isWriteDigest(write),
      `publish({ write }) for "${entity.$name}" is not a write digest`,
      "pass writeDigest(idempotencyKey) from '@ultimat3/core', or null for a write no request made",
    );
    const op = publishOptions.op ?? 'upsert';
    const changes = rows.map((row) => changeOf(projection, row, op, write));
    const sent = tail.then(async () => {
      // Every row the bus takes goes, a refused one in the middle included: its spent seq is the
      // hole the nodes repair, and the caller hears the first refusal once the rest are out.
      let refused: { readonly error: unknown } | undefined;
      for (const change of changes) {
        try {
          await send(change);
        } catch (error) {
          refused ??= { error };
        }
      }
      if (refused !== undefined) throw refused.error;
    });
    tail = sent.catch(() => undefined);
    await sent;
  };

  return { producer, publish, close, [Symbol.dispose]: close };
}
