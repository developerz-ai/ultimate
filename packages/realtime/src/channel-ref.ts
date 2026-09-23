// A channel's CLIENT half: its name, params and catch-up read, and the one topic builder — no
// entity, no policy, no registration. An island holds this; the server declares the same ref's
// records and policy with `channel(ref, { … })`, so name and params are written once and a browser
// chunk never carries `@ultimat3/entity`.

import { invariant } from '@ultimat3/core/page';
import { TopicForbiddenError } from './errors';

/** Branded so a raw string can never be published to; `topic()` is the only constructor. */
export type Topic = string & { readonly __ultimateTopic: unique symbol };

export const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** `topic('org', orgId, 'cursors')` -> `org.<orgId>.cursors`. Segments are validated, never escaped. */
export function topic(...parts: readonly (string | number)[]): Topic {
  const segments = parts.map((part) => String(part));
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new TopicForbiddenError({
        topic: segments.join('.'),
        actorId: null,
        reason: `segment "${segment}" must match ${SEGMENT.source} (dots and wildcards are reserved)`,
      });
    }
  }
  return segments.join('.') as Topic;
}

export type ChannelParams<K extends string> = Readonly<Record<K, string>>;

export interface ChannelRefInit<K extends string> {
  /** Ordered param names. Each becomes one topic segment, so each value is a segment-safe string. */
  readonly params: readonly K[];
  /**
   * The read a client re-runs on `replay-gap` or a new epoch — a query, by name. Read on every
   * access, never at declaration: `registerQueries()` stamps a declared query's name at boot.
   */
  readonly catchUp: { readonly name: string };
}

/** What a browser subscribes by — `useChannel(ref, params)`. */
export interface ChannelHandle<K extends string = string> {
  readonly kind: 'channel-ref';
  readonly name: string;
  readonly params: readonly K[];
  readonly catchUp: string;
  /** The topic for one set of params — the one spelling both halves use. */
  topic(params: ChannelParams<K>): Topic;
}

export function refuseChannel(name: string, detail: string, fix: string): never {
  invariant(false, 'X_CHANNEL_DECLARATION_INVALID', `channel("${name}"): ${detail}`, fix);
}

/** Refuses a bad name or a repeated param, and builds the ref. `channel()` is built on this. */
export function channelRef<const K extends string>(
  name: string,
  init: ChannelRefInit<K>,
): ChannelHandle<K> {
  if (!SEGMENT.test(name)) {
    refuseChannel(
      name,
      `the name must match ${SEGMENT.source}`,
      `rename it, e.g. channel('org-feed', …)`,
    );
  }
  if (new Set(init.params).size !== init.params.length) {
    refuseChannel(name, 'a param is listed twice', 'list each param once in params: [...]');
  }
  // `Object.hasOwn`, never a bare `params[param]`: params arrive off a subscribe frame, and an
  // inherited member would spell a topic nobody declared. Absent is `''`, which `topic()` refuses.
  const topicOf = (params: ChannelParams<K>): Topic =>
    topic(name, ...init.params.map((param) => (Object.hasOwn(params, param) ? params[param] : '')));
  return Object.freeze({
    kind: 'channel-ref' as const,
    name,
    params: init.params,
    get catchUp(): string {
      return init.catchUp.name;
    },
    topic: topicOf,
  });
}
