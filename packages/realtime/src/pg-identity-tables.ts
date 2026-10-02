// Single responsibility: which replicated tables need `REPLICA IDENTITY FULL` for a reason the
// live-query path does not have — a channel with params routes a DELETE by columns of the OLD row.

import type { Channel } from './channel-decl';
import { registeredChannels } from './channel-registry';

/**
 * The `records` tables of every channel declared with params, deduped and sorted.
 *
 * A live query never needs FULL on a keyed table: its shared window holds the whole row, so a
 * delete that names only the key is enough. A channel holds no window. Its removal is routed to
 * the topic the old row's params name (`channel-records.ts`), and under the default identity the
 * old image is the key alone — it names no topic, no `remove` is sent, and every member keeps the
 * deleted record. A channel with no params has one topic and needs nothing.
 */
export function paramsChannelTables(
  channels: Iterable<Channel> = registeredChannels(),
): readonly string[] {
  const tables = new Set<string>();
  for (const declared of channels) {
    if (declared.params.length === 0) continue;
    for (const projection of declared.records) tables.add(projection.table);
  }
  return [...tables].sort();
}
