// One ring entry → the `records` frame every member of its topic receives. The same frame for all
// of them: a channel's scope is its params, decided once at subscribe, never re-decided per row.

import type { Row } from '@ultimat3/core/page';
import type { RecordsEntry } from './channel-ring';
import type { ChannelAdopt, ChannelRecordsFrame, ChannelRemove } from './channel-wire';
import { PROTOCOL_VERSION } from './sync-protocol';

export function renderRecords(
  topic: string,
  epoch: string,
  entry: RecordsEntry,
): ChannelRecordsFrame {
  // Null-prototype maps: a record type and a record key are data, and `'__proto__'` stays a key.
  const adopt = Object.create(null) as Record<string, Record<string, Row>>;
  const remove = Object.create(null) as Record<string, string[]>;
  for (const part of entry.adopt) {
    const byKey = adopt[part.type] ?? (Object.create(null) as Record<string, Row>);
    byKey[part.key] = part.row;
    adopt[part.type] = byKey;
  }
  for (const part of entry.remove) {
    const keys = remove[part.type] ?? [];
    keys.push(part.key);
    remove[part.type] = keys;
  }
  return {
    type: 'records',
    v: PROTOCOL_VERSION,
    channel: topic,
    seq: entry.seq,
    epoch,
    ...(entry.adopt.length === 0 ? {} : { adopt: adopt as ChannelAdopt }),
    ...(entry.remove.length === 0 ? {} : { remove: remove as ChannelRemove }),
  };
}
