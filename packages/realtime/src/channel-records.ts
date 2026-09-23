// A committed change → the record updates each declared channel owes its subscribers. Pure: no
// socket, no seq, no policy — `ChannelHub` does those per node and per socket. The only derivation
// of "which channel carries this row" lives here, so a write never names a channel (axiom 2).

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
}

/**
 * `change.entity` is the replicated RELATION name (`pg-replication.ts` reads it off the Relation
 * message), so it is matched against each projection's `table`, never its `type`.
 *
 * - insert/update: the new row is adopted on the topic its params name.
 * - an update that moved the row to other params (`orgId` changed): a remove on the OLD topic too.
 * - delete: a remove on the topic the old image names — which needs the params columns in the
 *   `before` image, i.e. `REPLICA IDENTITY FULL`; a key-only image names no topic and is skipped.
 */
export function updatesFor(channels: Iterable<Channel>, change: ChangeEvent): TopicUpdate[] {
  const updates: TopicUpdate[] = [];
  for (const channel of channels) {
    const projection = channel.records.find((candidate) => candidate.table === change.entity);
    if (projection === undefined) continue;
    const after = change.op === 'delete' ? null : change.after;
    const before = change.before;
    const afterParams = after === null ? null : channel.paramsOf(after);
    const beforeParams = before === null ? null : channel.paramsOf(before);
    const afterTopic = afterParams === null ? null : channel.topic(afterParams);
    const beforeTopic = beforeParams === null ? null : channel.topic(beforeParams);

    if (after !== null && afterParams !== null && afterTopic !== null) {
      updates.push({
        channel,
        topic: afterTopic,
        params: afterParams,
        adopt: [{ type: projection.type, key: projection.key(after), row: after }],
        remove: [],
        row: after,
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
