// A committed change → the record updates each declared channel owes its subscribers. Pure: no
// socket, no seq, no policy — `ChannelHub` does those per node and per socket. The only derivation
// of "which channel carries this row" lives here, so a write never names a channel (axiom 2).

import { type Counter, counter, logger } from '@ultimat3/core';
import type { Row } from '@ultimat3/core/page';
import type { RecordProjection } from '@ultimat3/entity/record';
import type { ChangeEvent } from './changefeed';
import type { Channel, Topic } from './channel-decl';
import type { RecordPart } from './channel-ring';

/** One topic's share of one change. `row` is what a per-row policy decides on. */
export interface TopicUpdate {
  readonly channel: Channel;
  readonly topic: Topic;
  readonly params: Readonly<Record<string, string>>;
  readonly adopt: readonly RecordPart[];
  readonly remove: readonly { readonly type: string; readonly key: string }[];
  readonly row: Row;
  /**
   * The change could not carry this row whole (`ChangeEvent.omitted` names a column the record
   * projects), so there is nothing sound to adopt: the topic's members are told to re-read.
   */
  readonly gap?: true;
}

const removalsSkipped: Counter = counter('channel_removals_skipped_total', {
  unit: '{removal}',
  description:
    'Channel record removals that could not be routed: the old row image lacked the channel params (the table is not REPLICA IDENTITY FULL), so members keep the removed record.',
});
let skipped = 0;

/** Removals this process could not route since boot — the in-process read of the counter above. */
export function skippedRemovals(): number {
  return skipped;
}

/**
 * `change.table` is the replicated RELATION name (`pg-replication.ts` reads it off the Relation
 * message), so it is matched against each projection's `table`, never its `type`.
 *
 * - insert/update: the new row is adopted on the topic its params name.
 * - an update that moved the row to other params (`orgId` changed): a remove on the OLD topic too.
 * - delete: a remove on the topic the old image names — which needs the params columns in the
 *   `before` image, i.e. `REPLICA IDENTITY FULL`; a key-only image names no topic and is skipped
 *   — COUNTED and logged (`channel.removal_skipped`), because the members of that topic keep a
 *   record the database no longer has and nothing else would ever say so.
 */
export function updatesFor(channels: Iterable<Channel>, change: ChangeEvent): TopicUpdate[] {
  const updates: TopicUpdate[] = [];
  // A truncate names no row, so it routes to no topic here: `ChannelLogs` announces a gap on every
  // open topic of every channel carrying the relation instead (`truncatedTopics`).
  if (change.op === 'truncate') return updates;
  for (const channel of channels) {
    const projection = channel.records.find((candidate) => candidate.table === change.table);
    if (projection === undefined) continue;
    const after = change.op === 'delete' ? null : change.after;
    const before = change.before;
    const afterParams = after === null ? null : channel.paramsOf(after);
    const beforeParams = before === null ? null : channel.paramsOf(before);
    if (before !== null && beforeParams === null && channel.params.length > 0) {
      skipped += 1;
      removalsSkipped.add(1);
      logger.warn('channel.removal_skipped', { channel: channel.name, table: change.table });
    }
    const afterTopic = afterParams === null ? null : channel.topic(afterParams);
    const beforeTopic = beforeParams === null ? null : channel.topic(beforeParams);

    if (after !== null && afterParams !== null && afterTopic !== null) {
      // An unchanged out-of-line value Postgres logged no bytes for: adopted, the partial row
      // would be retained in the ring as the whole record and handed to every later joiner.
      const partial = (change.omitted ?? []).some((column) =>
        Object.hasOwn(projection.schema.properties ?? {}, column),
      );
      updates.push({
        channel,
        topic: afterTopic,
        params: afterParams,
        adopt: partial ? [] : [{ type: projection.type, key: projection.key(after), row: after }],
        remove: [],
        row: after,
        ...(partial ? { gap: true as const } : {}),
      });
    }
    if (
      before !== null &&
      beforeParams !== null &&
      beforeTopic !== null &&
      beforeTopic !== afterTopic
    ) {
      updates.push(removal(channel, projection, beforeTopic, beforeParams, before));
    }
  }
  return updates;
}

function removal(
  channel: Channel,
  projection: RecordProjection,
  topic: Topic,
  params: Readonly<Record<string, string>>,
  row: Row,
): TopicUpdate {
  return {
    channel,
    topic,
    params,
    adopt: [],
    remove: [{ type: projection.type, key: projection.key(row) }],
    row,
  };
}

/** The channels whose records a truncate of `table` wiped: every one listing that relation. */
export function carriesTable(channel: Channel, table: string): boolean {
  return channel.records.some((projection) => projection.table === table);
}
