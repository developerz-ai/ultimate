// Every `channel()` declared in this process, keyed by name — the realtime twin of the entity and
// query registries. `channel()` registers itself, so a host builds `new ChannelHub()` with no list
// and the manifest reads the same table (`channel-describe.ts`); a second declaration of one name
// is refused. Browser-safe: `channel()` runs in islands too.

import { invariant } from '@ultimat3/core';
import type { Channel } from './channel-decl';

const channels = new Map<string, Channel>();

export function registerChannel(declared: Channel): Channel {
  invariant(
    !channels.has(declared.name),
    'X_CHANNEL_DECLARATION_INVALID',
    `two channel() declarations share the name "${declared.name}"`,
    'rename one of them: a channel name is its topic prefix, so it must be unique per app',
  );
  channels.set(declared.name, declared);
  return declared;
}

/** The declaration of that name, or `undefined`. A `Map`, so a prototype member is never one. */
export function getChannel(name: string): Channel | undefined {
  return channels.get(name);
}

/** Sorted by name: a projection of the registry is a build input and must diff cleanly. */
export function registeredChannels(): readonly Channel[] {
  return [...channels.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test seam. Production code never unregisters a channel. */
export function clearChannels(): void {
  channels.clear();
}
