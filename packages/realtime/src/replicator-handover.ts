// Single responsibility: the replicator's last word on a CLEAN stop — "run P published everything
// up to `through`, its last sequence was N" — its subject, its bytes, its decode, and the publish.
// A sync node reads it so the next run, in another process, chains on instead of re-snapshotting.

import { logger, renderThrowable } from '@ultimat3/core';
import type { ChangeFeed } from './changefeed';
import type { Transport } from './fanout';
import type { DeadlineOutcome } from './replicator-deadline';

/**
 * Under `x.change.>`, so every node already subscribed hears it, on a token no table can spell
 * (`-`). A node that predates it reads no `table` and drops it — and so reads the next run as a
 * gap, as it always has. Mixed fleets fall back to "gap", never to "no gap".
 */
export const HANDOVER_SUBJECT = 'x.change.-handover';

/** The chain version: the same `v: 2` a run's first envelope carries its `from` under. */
const PREFIX = '{"handover":2,';

export interface Handover {
  readonly producer: string;
  /** The run's last published `seq` + 1: a tail this node never got shows as a hole before it. */
  readonly seq: number;
  /** Every change at or below this was published, by this run or before it (`ChangeFeed.position`). */
  readonly through: string;
  /** Where the run resumed — read only when it published nothing (`seq` 1). */
  readonly from?: string;
}

export function encodeHandover(handover: Handover): string {
  const { producer, seq, through, from } = handover;
  return `${PREFIX}${JSON.stringify({ producer, seq, through, ...(from === undefined ? {} : { from }) }).slice(1)}`;
}

/** The handover, or `null` for every other payload — a change envelope and a resync included. */
export function parseHandover(payload: string): Handover | null {
  if (!payload.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as {
      producer?: unknown;
      seq?: unknown;
      through?: unknown;
      from?: unknown;
    };
    const { producer, seq, through, from } = shape;
    if (typeof producer !== 'string' || typeof through !== 'string') return null;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
    return { producer, seq, through, ...(typeof from === 'string' ? { from } : {}) };
  } catch {
    return null;
  }
}

export interface HandOverArgs {
  readonly feed: ChangeFeed;
  readonly transport: Transport;
  readonly producer: string;
  /** The last seq this run published; 0 for none. */
  readonly published: number;
  readonly from: string | undefined;
  /** The stop deadline: a bus that will not take it must not hold the SIGTERM. */
  readonly bounded: (goodbye: Promise<void>) => Promise<DeadlineOutcome>;
}

/**
 * Said only after the feed stopped cleanly — its position is then how far the slot was confirmed.
 * Best effort: unsaid, the next run costs the one re-read it always did.
 */
export async function handOver(args: HandOverArgs): Promise<void> {
  const through = args.feed.position?.() ?? null;
  if (through === null) return;
  const payload = encodeHandover({
    producer: args.producer,
    seq: args.published + 1,
    through,
    ...(args.published === 0 && args.from !== undefined ? { from: args.from } : {}),
  });
  const outcome = await args.bounded(args.transport.publish(HANDOVER_SUBJECT, payload));
  if (outcome.how === 'done') return;
  logger.warn('replicator.handover_unpublished', {
    how: outcome.how,
    error: outcome.how === 'failed' ? renderThrowable(outcome.error) : 'past the stop deadline',
  });
}
