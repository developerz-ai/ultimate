// A declared channel, held by a component. Every holder of one topic on the page shares ONE
// membership on the page socket; its `records` land in the store (read them with `useRecord` /
// `useQuery`), and only `events` and presence reach the handlers given here.

import type { ChannelHandlers, ChannelRef, ChannelState } from './client-channels';
import { pageSocket } from './page-socket';
import { isServerRender, signalFor } from './reactivity';
import type { PresenceMember } from './sync-protocol';

/** The membership's state, callable, plus its release (Solid: `onCleanup`). */
export type ChannelAccessor = (() => ChannelState) & {
  release(): void;
  [Symbol.dispose](): void;
};

const nothing = (): void => undefined;

/**
 * Takes the `channel()` DECLARATION (any `ChannelRef` — a declaration is one), never a topic
 * string: the declaration is the only thing that may spell a topic (`bun run channel-literals`
 * holds it), so both halves spell it one way.
 */
export function useChannel<K extends string>(
  declared: ChannelRef<K>,
  params: Readonly<Record<K, string>>,
  handlers?: ChannelHandlers,
): ChannelAccessor {
  const signal = signalFor('useChannel');
  if (isServerRender()) {
    return Object.assign((): ChannelState => 'joining', {
      release: nothing,
      [Symbol.dispose]: nothing,
    });
  }
  const membership = pageSocket('useChannel').holdChannel(declared, params, handlers);
  const [version, setVersion] = signal(0);
  const off = membership.onChange(() => setVersion(version() + 1));
  const read = (): ChannelState => {
    version();
    return membership.state();
  };
  const release = (): void => {
    off();
    membership.release();
  };
  return Object.assign(read, { release, [Symbol.dispose]: release });
}

/** Who is in a channel's room, as the node's presence set says — one entry per member id. */
export type PresenceAccessor = (() => readonly PresenceMember[]) & {
  release(): void;
  [Symbol.dispose](): void;
};

/**
 * The roster of a channel declared with `events: true`: a `sync` replaces it, `join` / `update`
 * upsert a member, `leave` removes one. It is a membership of the channel like any other — the
 * same one `useChannel` holds, shared on the page — so holding both costs one subscribe.
 */
export function usePresence<K extends string>(
  declared: ChannelRef<K>,
  params: Readonly<Record<K, string>>,
): PresenceAccessor {
  const signal = signalFor('usePresence');
  if (isServerRender()) {
    return Object.assign((): readonly PresenceMember[] => [], {
      release: nothing,
      [Symbol.dispose]: nothing,
    });
  }
  const [version, setVersion] = signal(0);
  let members = new Map<string, PresenceMember>();
  const membership = pageSocket('usePresence').holdChannel(declared, params, {
    onPresence: (event) => {
      if (event.presence === 'sync') members = new Map();
      for (const member of event.members) {
        if (event.presence === 'leave') members.delete(member.id);
        else members.set(member.id, member);
      }
      setVersion(version() + 1);
    },
  });
  const read = (): readonly PresenceMember[] => {
    version();
    return [...members.values()];
  };
  return Object.assign(read, { release: membership.release, [Symbol.dispose]: membership.release });
}
