// Decoding the channel frames (plan 101, slices 09–10): `records` writes the page store, `events`
// never does, `replay-gap` is the node's verdict that a socket lost a `records` frame. Held to the
// same ceilings as every other kind — a `records` frame is rows a socket could otherwise size.

import { isWriteDigest, type Row, WRITE_DIGEST_LENGTH } from '@ultimat3/core/page';
import type {
  ChannelAdopt,
  ChannelEventsFrame,
  ChannelRecordsFrame,
  ChannelRemove,
  ChannelSince,
  ChannelSubscribeTarget,
  ReplayGapFrame,
} from './channel-wire';
import { isJsonObject, type JsonObject } from './json';
import { fail, list, num, object, str } from './wire-read';
import { FRAME_LIMITS, PROTOCOL_VERSION } from './wire-version';

export function records(parsed: JsonObject): ChannelRecordsFrame {
  const base = {
    type: 'records',
    v: PROTOCOL_VERSION,
    channel: str(parsed, 'channel'),
    seq: num(parsed, 'seq'),
    epoch: str(parsed, 'epoch'),
  } as const;
  const adopt = parsed['adopt'] === undefined ? undefined : adoptOf(parsed['adopt']);
  const remove = parsed['remove'] === undefined ? undefined : removeOf(parsed['remove']);
  const write = parsed['write'];
  if (write !== undefined && !isWriteDigest(write)) {
    throw fail(`records.write must be a ${WRITE_DIGEST_LENGTH}-character lowercase hex digest`);
  }
  return {
    ...base,
    ...(adopt === undefined ? {} : { adopt }),
    ...(remove === undefined ? {} : { remove }),
    ...(write === undefined ? {} : { write }),
  };
}

export function events(parsed: JsonObject): ChannelEventsFrame {
  return {
    type: 'events',
    v: PROTOCOL_VERSION,
    channel: str(parsed, 'channel'),
    event: object(parsed['event']),
  };
}

export function replayGap(parsed: JsonObject): ReplayGapFrame {
  return {
    type: 'replay-gap',
    v: PROTOCOL_VERSION,
    channel: str(parsed, 'channel'),
    epoch: str(parsed, 'epoch'),
  };
}

/** `subscribe.target` for a declared channel: a name, string params (capped), an optional resume. */
export function channelTarget(value: JsonObject): ChannelSubscribeTarget {
  const raw = object(value['params'] ?? {});
  const entries = Object.entries(raw);
  if (entries.length > FRAME_LIMITS.channelParams) {
    throw fail(
      `channel params carry ${entries.length}, over the limit of ${FRAME_LIMITS.channelParams}`,
    );
  }
  const params: Record<string, string> = {};
  for (const [key, param] of entries) {
    if (typeof param !== 'string') throw fail(`channel param "${key}" must be a string`);
    params[key] = param;
  }
  const base = { kind: 'channel', channel: str(value, 'channel'), params } as const;
  return value['since'] === undefined || value['since'] === null
    ? base
    : { ...base, since: sinceOf(value['since']) };
}

function sinceOf(value: unknown): ChannelSince {
  if (!isJsonObject(value)) throw fail('channel since must be an object');
  const seq = num(value, 'seq');
  if (!Number.isInteger(seq) || seq < 0) throw fail('channel since.seq must be a whole number');
  return { epoch: str(value, 'epoch'), seq };
}

/** type → key → row. Every row an object, and the whole frame under the snapshot row ceiling. */
function adoptOf(value: unknown): ChannelAdopt {
  if (!isJsonObject(value)) throw fail('records.adopt must be an object');
  let total = 0;
  const out: Record<string, Readonly<Record<string, Row>>> = {};
  for (const [type, keyed] of Object.entries(value)) {
    if (!isJsonObject(keyed)) throw fail(`records.adopt.${type} must be an object`);
    const rows: Record<string, Row> = {};
    for (const [key, row] of Object.entries(keyed)) {
      total += 1;
      if (total > FRAME_LIMITS.rows) {
        throw fail(`records.adopt carries more than ${FRAME_LIMITS.rows} rows`);
      }
      rows[key] = object(row);
    }
    out[type] = rows;
  }
  return out;
}

function removeOf(value: unknown): ChannelRemove {
  if (!isJsonObject(value)) throw fail('records.remove must be an object');
  const out: Record<string, readonly string[]> = {};
  for (const type of Object.keys(value)) {
    out[type] = list(value, type, FRAME_LIMITS.rows, `records.remove.${type}`).map((key) => {
      if (typeof key !== 'string') throw fail(`records.remove.${type} must hold strings`);
      return key;
    });
  }
  return out;
}
