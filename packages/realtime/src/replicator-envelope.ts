// The bus envelope, both sides: the one encoder every producer writes with (`replicator.ts`,
// `record-publisher.ts`), its decode back into a `ChangeEvent` (rows revived through their entity's
// columns) with the producer and sequence a lost message is visible in, and the detector a `sync`
// node runs over them.

import { isWriteDigest } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { busRow, reviveBusRow } from './replicator-row';

/**
 * What the bus actually carries: one change, plus who published it and where in that publisher's
 * stream it sits.
 *
 * Fanout is core NATS — `publish`, no ack, at most once — so a consumer that reads only the change
 * cannot tell "nothing happened" from "eleven changes went past while I was reconnecting". An lsn
 * cannot answer it either: a WAL position is a byte offset, so a legitimate next change is an
 * arbitrary jump forwards. A per-publisher counter is the one number a gap is visible in.
 *
 * Both fields are optional on the wire, so a node reading a publisher that predates them simply
 * detects nothing — the same rule the `snapshot.entity` field follows, on a subject no client sees.
 */
export interface ChangeEnvelope {
  readonly change: ChangeEvent;
  /** Monotonic within `producer`, from 1. `null` from a publisher that does not sequence. */
  readonly seq: number | null;
  /** Identifies one replicator *run*. A new one restarts `seq` — and follows a stream that died. */
  readonly producer: string | null;
  /**
   * Who sequenced it. Absent is the replicator (every publisher that predates the field). A
   * `recordPublisher` says `'publisher'`: its changes carry no commit position, so they feed the
   * declared channels and never a live window, and several publishers run side by side.
   */
  readonly source?: EnvelopeSource;
}

/** The two producers of the change bus: the one WAL replicator, and an app's record publishers. */
export type EnvelopeSource = 'replicator' | 'publisher';

/**
 * Producer side: one change as the bus carries it. Flat — the change plus `seq`, `producer` and,
 * for a record publisher, `source` — so a consumer that only knows the change reads it unchanged
 * (`parseChange`). Rows cross as `busRow` writes them: bytes as base64, revived by the entity.
 */
export function encodeEnvelope(
  change: ChangeEvent,
  seq: number,
  producer: string,
  source?: EnvelopeSource,
): string {
  return JSON.stringify({
    ...change,
    before: busRow(change.before),
    after: busRow(change.after),
    seq,
    producer,
    ...(source === 'publisher' ? { source } : {}),
  });
}

/** Sync-node side of the bus: decode a published change back into a `ChangeEvent`. */
export function parseChange(payload: string): ChangeEvent | null {
  return parseEnvelope(payload)?.change ?? null;
}

/** The same decode, keeping the two fields a gap is visible in. `parseChange` is this, narrowed. */
export function parseEnvelope(payload: string): ChangeEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as Partial<ChangeEvent> & {
      seq?: unknown;
      producer?: unknown;
      source?: unknown;
      entity?: unknown;
    };
    // `entity` is the field a 24.x replicator wrote the table under. Read, never written: across a
    // rolling deploy to 25.0.0 the replicator and the sync nodes run different builds for minutes,
    // and a node refusing every change of the old one is every live view frozen for that window.
    const table = typeof shape.table === 'string' ? shape.table : shape.entity;
    if (typeof table !== 'string' || typeof shape.lsn !== 'string') return null;
    if (
      shape.op !== 'insert' &&
      shape.op !== 'update' &&
      shape.op !== 'delete' &&
      shape.op !== 'truncate'
    ) {
      return null;
    }
    return {
      change: {
        table,
        op: shape.op,
        before: reviveBusRow(table, shape.before ?? null),
        after: reviveBusRow(table, shape.after ?? null),
        lsn: shape.lsn,
        txid: typeof shape.txid === 'string' ? shape.txid : '',
        orgId: typeof shape.orgId === 'string' ? shape.orgId : null,
        at: typeof shape.at === 'number' ? shape.at : 0,
        // Only the minted shape crosses: a frame decoder refuses anything else, so a malformed
        // label here would cost every member the whole frame rather than one page its echo.
        write: isWriteDigest(shape.write) ? shape.write : null,
        ...(isNames(shape.omitted) ? { omitted: shape.omitted } : {}),
      },
      seq: typeof shape.seq === 'number' && Number.isFinite(shape.seq) ? shape.seq : null,
      producer: typeof shape.producer === 'string' ? shape.producer : null,
      ...(shape.source === 'publisher' ? { source: 'publisher' as const } : {}),
    };
  } catch {
    return null;
  }
}

/** A non-empty list of property names — the only shape `ChangeEvent.omitted` crosses the bus in. */
const isNames = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string');

/**
 * The consume-side twin of the publisher's counter, and the only thing on a `sync` node that can
 * say "this node missed changes". Publish-side duplicate and out-of-order guards already existed;
 * there was no equivalent here, so a NATS blip during a rolling restart was eleven changes that
 * simply never happened as far as every subscriber on this node could tell.
 *
 * Per producer, because a replicator restart legitimately rewinds the counter. A repeat or a
 * reordering is *not* reported as a gap — the window's own lsn guard refuses those — and neither is
 * the first message this node ever reads: a node that joined late has missed everything by
 * definition, and every subscription it holds started after it did.
 *
 * A NEW producer after a known one IS a gap. The run before it died — that is why there is a new
 * one — and nothing says its last messages reached this node: the tail of a dead stream has no
 * later sequence number to be missed against. One re-read per replicator restart is the price.
 *
 * Only a REPLICATOR run succeeds another. Record publishers (`source: 'publisher'`) run side by
 * side, one per app process, so a new one says nothing about the others; and a replicator run
 * after a publisher is no successor either. A hole inside any one producer's sequence is a gap.
 */
export class SeqGapDetector {
  readonly #next = new Map<string, number>();
  /** Replicator runs read — the producers a NEW replicator run succeeds. */
  readonly #runs = new Set<string>();

  /** `true` when at least one message between the last one and this one was never delivered. */
  observe(envelope: ChangeEnvelope): boolean {
    const { producer, seq } = envelope;
    if (producer === null || seq === null) return false;
    const expected = this.#next.get(producer);
    const replicator = envelope.source !== 'publisher';
    const succeeds = replicator && expected === undefined && this.#runs.size > 0;
    if (replicator) this.#runs.add(producer);
    // Never backwards: a redelivery must not lower the bar and turn the next legitimate message
    // into a gap of its own.
    this.#next.set(producer, Math.max(expected ?? 0, seq + 1));
    return succeeds || (expected !== undefined && seq > expected);
  }

  /** Producers this node has read. Bounded by replicator restarts, so it is swept on a drain. */
  forget(): void {
    this.#next.clear();
    this.#runs.clear();
  }
}
