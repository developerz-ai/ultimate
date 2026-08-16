// The `sync` role: which live queries this node serves, who is dialling it, and the socket it owns.
// Split from `dev-roles.ts` because it is the one role with an authenticator, a presence registry
// and a listener of its own — and because that file is the boot's index, not its detail.

import { createContext, logger } from '@ultimat3/core';
import { listQueries } from '@ultimat3/query';
import {
  ChannelHub,
  createSyncNode,
  LiveQueryRegistry,
  listenSyncNode,
  liveQueryDefinition,
  PresenceRegistry,
  RingChangeBuffer,
  SocketRegistry,
} from '@ultimat3/realtime';
import type { StartRolesOptions } from './dev-roles';
import { syncAuthenticator } from './sync-authenticator';

/** What `startRoles` holds on to: where the node listens, and how to take it down. */
export interface RunningSync {
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Every read the app declared `live: true` becomes a subscribable query on this node, through
 * `@ultimat3/realtime`'s own bridge. A registry with nothing in it answers every live `subscribe`
 * with "no live query registered", which is a working socket serving no reads — and it is what
 * kept the row gate that decides per subscriber from ever running outside a unit test.
 *
 * The context is the node's, and it carries no actor: it supplies the services and the clock the
 * shared read needs, never an authority. Who may subscribe, and which rows they see, is decided
 * per socket at subscribe time and again for every row of every delivery.
 *
 * **The per-TENANT subscription cap is deliberately unset, and both halves of it are.**
 * `assertCapacity` returns early unless `maxPerTenant` AND `tenantOf` are both given, so passing
 * one arms nothing — a knob that quietly does nothing is the defect this whole seam exists to
 * close. And no default is defensible: one tenant is a single person and the next is five
 * thousand seats, so any number here is either unreachable or an outage on a Monday morning. The
 * per-socket 128 stands because a socket is one browser tab, which is a bound the framework can
 * actually know. A deployment that wants the tenant cap passes both:
 *
 *   new LiveQueryRegistry({ …, maxPerTenant: 5_000, tenantOf: (actor) => actor?.orgId ?? null })
 */
export function registerLiveQueries(options: StartRolesOptions): LiveQueryRegistry {
  const registry = new LiveQueryRegistry({
    source: new RingChangeBuffer(),
    // A withheld row is a metric, never a frame and never an error: telling a client "there is a
    // row you may not see" is the leak the gate exists to prevent.
    onRowDenied: (event) => logger.debug('live.rows_denied', { ...event }),
  });
  const ctx = createContext({ role: 'sync', buildId: options.buildId });
  for (const target of listQueries()) {
    if (target.isLive) registry.register(liveQueryDefinition(target, { ctx }));
  }
  return registry;
}

/**
 * The sync role owns its own socket: websockets and the request pipeline drain differently.
 *
 * Port 0 is passed straight through rather than incremented — `+ 1` would ask the kernel for
 * port 1 instead of an ephemeral one — and the reported url is the listener's own bound address,
 * never a string built from the port that was requested.
 */
export async function startSync(options: StartRolesOptions): Promise<RunningSync> {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport: options.runtime.transport, sockets });
  // The node evaluated no credential of its own and no host ever handed it one, so every socket
  // the framework opened was anonymous and every guard, gate, presence entry and tenant cap
  // decided against `null`. An explicit override first — only that one can carry an `expiresAt`
  // and a `refresh`, which is the whole of re-authorization — then the app's own HTTP resolver,
  // then nothing at all, which is what `x dev` with no authenticator should stay.
  const authenticate = options.overrides?.syncAuthenticate ?? syncAuthenticator(options.buildId);
  const node = createSyncNode({
    hub,
    registry: registerLiveQueries(options),
    transport: options.runtime.transport,
    buildId: options.buildId,
    sockets,
    ...(authenticate === undefined ? {} : { authenticate }),
    // Tier 1 is presence, and without a registry the node answers a topic subscribe with no member
    // list at all — the KV bucket the transport just created would hold nothing and every `sync`
    // container would run a presence-less protocol. It reads and writes `transport.shared`, so it
    // is exactly as multi-node as the transport behind it: in-process here, the bucket under NATS.
    presence: new PresenceRegistry({
      transport: options.runtime.transport,
      hub,
      ttlMs: options.runtime.presenceTtlMs,
    }),
  });
  await node.start();
  try {
    const listener = listenSyncNode(node, { port: options.port === 0 ? 0 : options.port + 1 });
    return {
      url: listener.url,
      stop: async () => {
        listener.stop();
        await node.stop();
      },
    };
  } catch (error) {
    await node.stop();
    throw error;
  }
}
