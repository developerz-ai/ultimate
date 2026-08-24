// The `sync` role: which live queries this node serves, who is dialling it, and the socket it owns.
// Split from `dev-roles.ts` because it is the one role with an authenticator, a presence registry
// and a listener of its own — and because that file is the boot's index, not its detail.

import { createContext, logger, UltimateError } from '@ultimat3/core';
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
} from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './dev-roles';
import { neighbouringPort, PORT_RANGE } from './flag-number';
import { portFree } from './port-probe';
import { syncAuthenticator } from './sync-authenticator';

/**
 * Beside its one thrower rather than in `errors.ts`, which is at 461 of the 500-line ceiling —
 * the arrangement `db-seed.ts` and `metrics-endpoint.ts` already take. The code is
 * `X_PORT_INVALID`, this package's own: "the port asked for is not one" is what it already means,
 * and a second code for the same fact is the synonym the registry exists to prevent.
 */
class SyncPortUnavailableError extends UltimateError {
  constructor(input: { port: number }) {
    super({
      code: 'X_PORT_INVALID',
      cause: `the sync role binds PORT + 1, and PORT=${input.port} is the top of the range — it would ask for ${input.port + 1}, which is not a TCP port`,
      fix: `x dev --port ${neighbouringPort(input.port)}   # leaves ${PORT_RANGE.max} free for the sync node`,
      meta: { port: input.port },
    });
  }
}

/**
 * The neighbour was already listening. `X_PORT_IN_USE` is this package's own and is exactly what
 * `x doctor` reports for the same condition, so one taken port has one name wherever it is found.
 *
 * What shipped instead: `listenSyncNode`'s `Bun.serve` threw, `startSync` re-threw, and the
 * dispatcher rendered the caught value into `X_CLI_UNEXPECTED`'s cause —
 * `cause: Error: Failed to start server. Is port 4000 in use?`, `fix: x doctor --json`, from a
 * command that had just printed `web listening on 3999`. Three defects in one output: an
 * unstable code, a caught value rendered into a refusal, and a `fix:` that answered
 * "no findings — environment is shippable" when run (#F5).
 */
class SyncPortInUseError extends UltimateError {
  constructor(input: { port: number; webPort: number }) {
    super({
      code: 'X_PORT_IN_USE',
      cause: `the sync role binds PORT + 1, so \`x dev --port ${input.webPort}\` needs port ${input.port} and something is already listening on it`,
      fix: `x dev --port ${neighbouringPort(input.webPort)}   # or free port ${input.port}: lsof -nP -iTCP:${input.port} -sTCP:LISTEN`,
      meta: { port: input.port, webPort: input.webPort },
    });
  }
}

/**
 * What a failed `listenSyncNode` really was, ASKED rather than read off the caught value: the
 * thrown thing is `Bun.serve`'s own English and interpolating it into a `cause:` is what
 * `scripts/catch-render.ts` refuses. `undefined` means "not a taken port" and the original value
 * is re-thrown untouched — a catch-all that renamed every listener failure would be worse than
 * the bare one it replaced.
 *
 * `probe` is injected so a test can be exactly "the port was taken" without racing a real socket.
 */
export async function syncBindRefusal(
  webPort: number,
  port: number,
  probe: (value: number) => Promise<boolean> = portFree,
): Promise<UltimateError | undefined> {
  if (await probe(port)) return undefined;
  return new SyncPortInUseError({ port, webPort });
}

/**
 * The port the sync node listens on. `PORT + 1`, and `0` stays `0` — the kernel picks, and adding
 * one to it would pick a specific port instead.
 *
 * REFUSED at the top of the range, never clamped. `PORT_RANGE.max` is 65535 and `portValue`
 * accepts it, so `x dev --port 65535` handed `Bun.serve` 65536 and the bare `RangeError` reached
 * the terminal as `X_CLI_UNEXPECTED` with `fix: x doctor --json`. Clamping to 65534 would be worse
 * than refusing: `PORT + 1` is the rule `docker/docker-compose.prod.yml` publishes `3001:3001`
 * from and `docker/helm` derives `PORT = .port - 1` from, so a node quietly on `PORT - 1` is a
 * socket nothing else in the deployment computes.
 */
export function syncPortFor(port: number): number {
  if (port === 0) return 0;
  if (port >= PORT_RANGE.max) throw new SyncPortUnavailableError({ port });
  return port + 1;
}

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
  // decided against `null`. An explicit override first, then the app's own HTTP resolver, then
  // nothing at all, which is what `x dev` with no authenticator should stay.
  //
  // BOTH of the first two re-authorize: `syncAuthenticator` carries an `expiresAt` and a `refresh`
  // of its own (`SYNC_GRANT_TTL_MS`), re-asking the app's resolver with the upgrade's own
  // `cookie`/`authorization`, so `logout` closes the socket and not only the HTTP session. The
  // override is how a deployment states a window its credential already declares (a token's
  // `exp`), or resolves identity from a header the adapter deliberately does not retain.
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
  const port = syncPortFor(options.port);
  try {
    const listener = listenSyncNode(node, { port });
    return {
      url: listener.url,
      stop: async () => {
        listener.stop();
        await node.stop();
      },
    };
  } catch (error) {
    await node.stop();
    const refusal = await syncBindRefusal(options.port, port);
    if (refusal !== undefined) throw refusal;
    throw error;
  }
}
