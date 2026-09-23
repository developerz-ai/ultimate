// `channel(name, { params, policy, catchUp, records, events })` — the ONLY way to declare a channel,
// and through its ref the only way to spell a topic. `channel(ref, { records, policy })` is the
// same declaration for a ref an island already holds (`channel-ref.ts`): the browser chunk then
// carries the name and params, never `@ultimat3/entity` (plan 101, slice 09).

import type { Ctx, Row } from '@ultimat3/core';
import {
  type ProjectedEntity,
  type RecordProjection,
  recordProjection,
} from '@ultimat3/entity/record';
import type { QueryPolicy } from '@ultimat3/query';
import {
  type ChannelHandle,
  type ChannelParams,
  type ChannelRefInit,
  channelRef,
  refuseChannel,
  SEGMENT,
  type Topic,
} from './channel-ref';
import { registerChannel } from './channel-registry';

export { type ChannelParams, type Topic, topic } from './channel-ref';

/** What `records: [posts]` accepts: anything `entity()` built. */
export type ChannelEntity = ProjectedEntity;

/** `recordProjection`, refused in this declaration's words rather than the entity's. */
function projectionFor(name: string, entity: ChannelEntity): RecordProjection {
  try {
    return recordProjection(entity);
  } catch {
    return refuseChannel(
      name,
      `records lists "${entity.$name}", which carries no record brand`,
      'list entities declared with entity() from @ultimat3/entity',
    );
  }
}

/** What only the server half declares: the rows it carries and who may join. */
export interface ChannelServerInit {
  /**
   * Evaluated on subscribe: the params are the input, and `row` is what the loader below answered
   * (`null` without one). Omitted = any socket may join. Records are NOT gated per row — the topic's
   * params are the scope, so a channel that must hide rows is declared narrower.
   */
  readonly policy?: QueryPolicy;
  /**
   * The subject the policy decides about, loaded by the SURFACE before the rule runs — the same
   * split an action's `row:` makes, because a rule is synchronous and membership is a read.
   */
  readonly row?: ChannelRowLoader;
  /** Entities whose committed rows this channel carries as records, matched to params BY NAME. */
  readonly records?: readonly ChannelEntity[];
  /** Whether the channel also carries ephemeral `events` frames. */
  readonly events?: boolean;
}

export type ChannelInit<K extends string> = ChannelRefInit<K> & ChannelServerInit;

export type ChannelRowLoader = (args: {
  readonly params: Readonly<Record<string, string>>;
  readonly ctx: Ctx;
}) => unknown;

export interface Channel<K extends string = string> {
  readonly kind: 'channel';
  readonly name: string;
  readonly params: readonly K[];
  readonly policy: QueryPolicy | undefined;
  readonly row: ChannelRowLoader | undefined;
  readonly catchUp: string;
  readonly records: readonly RecordProjection[];
  readonly events: boolean;
  /** The topic for one set of params — the one spelling both sides use. */
  topic(params: ChannelParams<K>): Topic;
  /**
   * The params a committed row of a listed entity belongs to: each param read off the row's
   * property of the SAME NAME. `null` when the row lacks one (a partial `before` image).
   */
  paramsOf(row: Row): ChannelParams<K> | null;
}

/**
 * Registers the declaration (`channel-registry.ts`) — a second one of the same name is refused.
 *
 * The params-matching rule, decided here once: a row belongs to the topic whose params equal the
 * row's own properties of those names. So `channel('org-feed', { params: ['orgId'], records:
 * [posts] })` carries every `posts` row on `org-feed.<row.orgId>`, and every listed entity must have
 * a column named after every param — refused at declaration, where the author is.
 */
export function channel<const K extends string>(name: string, init: ChannelInit<K>): Channel<K>;
export function channel<K extends string>(
  ref: ChannelHandle<K>,
  init: ChannelServerInit,
): Channel<K>;
export function channel<K extends string>(
  nameOrRef: string | ChannelHandle<K>,
  init: ChannelInit<K> | ChannelServerInit,
): Channel<K> {
  const ref =
    typeof nameOrRef === 'string' ? channelRef(nameOrRef, init as ChannelInit<K>) : nameOrRef;
  const name = ref.name;
  const records = (init.records ?? []).map((entity) => {
    const projection = projectionFor(name, entity);
    for (const param of ref.params) {
      if (!Object.hasOwn(projection.schema.properties ?? {}, param)) {
        refuseChannel(
          name,
          `param "${param}" is not a column of "${projection.type}", so its rows match no topic`,
          `rename the param to a column every listed entity has, or drop ${projection.type} from records`,
        );
      }
    }
    return projection;
  });

  const declared: Channel<K> = Object.freeze({
    kind: 'channel' as const,
    name,
    params: ref.params,
    policy: init.policy,
    row: init.row,
    get catchUp(): string {
      return ref.catchUp;
    },
    records,
    events: init.events === true,
    topic: ref.topic,
    paramsOf: (row: Row): ChannelParams<K> | null => {
      const params: Partial<Record<K, string>> = {};
      for (const param of ref.params) {
        const value = Object.hasOwn(row, param) ? row[param] : undefined;
        if (typeof value !== 'string' || !SEGMENT.test(value)) return null;
        params[param] = value;
      }
      return params as ChannelParams<K>;
    },
  });
  registerChannel(declared);
  return declared;
}
