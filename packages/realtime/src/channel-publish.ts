// A channel `events` frame on the bus, from a process that serves no socket: `publishChannelEvent`
// is what a job or an action calls. The `ChannelHub` lives in the `sync` role alone, so until this
// seam a worker had no way to reach one, and an events-only channel could be fed only by a socket.
// The frame and its subject are spelled here once; the hub's own `emit` publishes through them.

import { assertCoded } from '@ultimat3/core';
import { adapterSlot } from '@ultimat3/core/adapter';
import type { Channel, Topic } from './channel-decl';
import type { ChannelEventsFrame } from './channel-wire';
import { InProcessTransport, type Transport } from './fanout';
import type { JsonObject } from './json';
import { PROTOCOL_VERSION } from './sync-protocol';

const CHANNEL_SUBJECT_PREFIX = 'x.channel';

/** The transport subject one topic's `events` frames ride — what a node's bridge subscribes to. */
export const channelSubject = (name: Topic): string => `${CHANNEL_SUBJECT_PREFIX}.${name}`;

/** One `events` frame onto `transport`: the single encoding, for the hub and for a publisher. */
export async function sendChannelEvent(
  transport: Transport,
  name: Topic,
  event: JsonObject,
): Promise<void> {
  const frame: ChannelEventsFrame = { type: 'events', v: PROTOCOL_VERSION, channel: name, event };
  await transport.publish(channelSubject(name), JSON.stringify(frame));
}

/**
 * The buses installed, newest last, over the heap bus a process boots with — nobody subscribes to
 * that one, so a unit test or a script that booted nothing publishes to nobody instead of throwing
 * in the middle of the write it follows. Core's one frame stack: a release puts back what was there
 * before it, and one transport installed twice is two frames.
 */
const booted: Transport = new InProcessTransport();
const installed = adapterSlot<Transport>(() => booted);

/**
 * Called by the boot (`startServices`) with the process's transport — `apps/<app>/runtime.ts`'s
 * `transport`, else the one `selectTransport` chose — in EVERY role: the same object the `sync`
 * role's hub subscribes on, so under `x dev` a publish reaches this process's own sockets and under
 * NATS every node's. Answers the release, which takes THIS install off the stack and so restores
 * whatever was current before it (the boot's bus under a test's override); idempotent, and a
 * release out of order removes only its own entry. Public on `@ultimat3/realtime/adapter` only: an
 * app swaps the bus in `runtime.ts`, never by calling this.
 */
export function installChannelTransport(transport: Transport): () => void {
  return installed.install(transport);
}

/**
 * An ephemeral event to every member of `declared`'s topic for `params`, on every node — from any
 * process the framework booted. Never stored and never replayed: a member that was offline does not
 * get it, so an event says "re-read", never "here is the state".
 *
 * **Call it after the transaction commits.** Nothing here can see a transaction: an event sent
 * from inside one is on every page before a rollback. At-most-once — a bus that refuses the send
 * rejects (`X_TRANSPORT_UNAVAILABLE` from NATS), and the caller decides whether that is worth
 * failing for.
 */
export async function publishChannelEvent<K extends string>(
  declared: Channel<K>,
  params: Readonly<Record<K, string>>,
  event: JsonObject,
): Promise<void> {
  assertCoded(
    declared.events,
    'X_CHANNEL_DECLARATION_INVALID',
    `channel("${declared.name}") declares no events, so nothing may publish one on it`,
    `declare it with events: true: channel('${declared.name}', { …, events: true })`,
  );
  await sendChannelEvent(installed.current(), declared.topic(params), event);
}
