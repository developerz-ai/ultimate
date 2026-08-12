// Running the roles. In production these are separate containers selected by `ROLE`; `x dev`
// runs them in one process by starting the same framework objects each container starts, so a
// job that only works when awaited inline still fails here.
//
// `migrate` is absent on purpose: it is run-once (`x db migrate`), not a process. `replicator` is
// selectable but not default — it takes a replication slot on a shared database, which is not
// something every `x dev` in a team should do to the same server by simply starting.

import type { Role } from '@ultimat3/core';
import { createContext, isRole, logger, ROLES } from '@ultimat3/core';
import type { Route, ServerHandle } from '@ultimat3/http';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { Scheduler, Worker } from '@ultimat3/jobs';
import { createScheduler, createWorker } from '@ultimat3/jobs';
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
import { devHooks } from './dev-hooks';
import type { RunningReplicator } from './dev-replicator';
import { startReplicator } from './dev-replicator';
import type { RunningServices } from './dev-runtime';
import type { Env } from './dev-services';
import { BadFlagError } from './errors';
import { DEFAULT_METRICS_PORT, startMetricsEndpoint } from './metrics-endpoint';
import { inlineStyleSources } from './style-csp';

/** The roles `x dev` starts when `--role` names none, in boot order. */
export const DEV_ROLES: readonly Role[] = ['web', 'sync', 'worker', 'scheduler'];

/**
 * What `--role` accepts. The replicator is here but not in `DEV_ROLES`: opt-in, because it takes
 * the one replication slot a database has, and a default that did that would mean two developers
 * pointed at one staging database silently fighting over it.
 */
export const SELECTABLE_ROLES: readonly Role[] = [...DEV_ROLES, 'replicator'];

export interface StartRolesOptions {
  readonly roles: readonly Role[];
  readonly port: number;
  readonly buildId: string;
  readonly runtime: RunningServices;
  /** Routes the web role serves: `/_x`, the actions, the pages. */
  readonly routes: readonly Route[];
  /** The process environment, for the roles that resolve a driver from it. */
  readonly env: Env;
  /**
   * How the web role binds and what it admits about itself. `x dev` keeps the default —
   * loopback, `dev: true`, so a laptop on a café network is not serving the app to the café. A
   * container passes `{ dev: false, hostname: '0.0.0.0' }`: a process bound to `localhost` inside
   * a container is unreachable from the port mapping, the load balancer and every PaaS health
   * probe, which is the same failure in four costumes.
   */
  readonly http?: WebBinding;
  /**
   * The app's `auth.signInPath`. Threaded rather than read from the config here because
   * `startRoles` takes plain values — a test starts a web role with no `app.config.ts` at all.
   */
  readonly signInPath?: string | null;
  /**
   * Inline `<style>` bodies this process serves that the app's own surfaces do not account for —
   * `/_x`'s shell. The surfaces themselves are read from the stylesheet registry here rather than
   * passed, so no caller of `startRoles` can ship a web server whose CSP blocks the pages it
   * serves: that policy is what rendered every deployed app completely unstyled.
   */
  readonly inlineStyles?: readonly string[];
  /**
   * Where the scrape listener binds. Defaults to `DEFAULT_METRICS_PORT`, except when `port` is 0
   * — a caller asking the kernel for an ephemeral HTTP port is a test, and a test that grabbed
   * 9090 would fail the next one to run beside it.
   */
  readonly metricsPort?: number;
}

export interface WebBinding {
  readonly dev: boolean;
  readonly hostname: string;
}

/** Loopback and dev-mode. What `x dev` means, and what a container must override. */
export const DEV_BINDING: WebBinding = { dev: true, hostname: 'localhost' };

export interface RunningRoles {
  readonly roles: readonly Role[];
  /** `http://…` once the web role is up; null when it was not selected. */
  readonly url: string | null;
  /** Where the sync role accepts websockets; null when it was not selected. */
  readonly syncUrl: string | null;
  /** `http://…` — the scrape base. Never null: every role publishes a signal worth scaling on. */
  readonly metricsUrl: string;
  readonly server: ServerHandle | null;
  readonly worker: Worker | null;
  readonly scheduler: Scheduler | null;
  /** The slot and feed this process holds; null when the replicator was not selected. */
  readonly replicator: RunningReplicator | null;
  stop(): Promise<void>;
}

/**
 * `--role web,worker` picks a subset. An unknown or out-of-scope role is a flag error with the
 * working invocation in the fix line, never a silently ignored value — which is what it was.
 */
export function selectRoles(flag: string | undefined): readonly Role[] {
  if (flag === undefined || flag.trim().length === 0) return DEV_ROLES;
  const wanted = flag
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const selected: Role[] = [];
  for (const name of wanted) {
    if (!isRole(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" is not a role (known: ${ROLES.join(', ')})`,
        fix: `x dev --role ${DEV_ROLES.join(',')}`,
      });
    }
    if (!SELECTABLE_ROLES.includes(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" does not run under x dev (it runs once, as \`x db migrate\`)`,
        fix: `x dev --role ${DEV_ROLES.join(',')}`,
      });
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return SELECTABLE_ROLES.filter((role) => selected.includes(role));
}

function startWeb(options: StartRolesOptions): ServerHandle {
  const binding = options.http ?? DEV_BINDING;
  return createServer({
    routes: options.routes,
    role: 'web',
    hooks: devHooks(),
    config: defineHttpConfig({
      port: options.port,
      dev: binding.dev,
      buildId: options.buildId,
      hostname: binding.hostname,
      signInPath: options.signInPath ?? null,
      // Hashes, never `'unsafe-inline'`: a `render: 'static'` page is a file on disk, so
      // nothing can stamp a per-response nonce into it, but its body is fixed and a hash is a
      // function of that body. Read after `loadApp` — importing the app IS what registered them.
      security: {
        csp: { extend: { 'style-src': inlineStyleSources(options.inlineStyles ?? []) } },
      },
    }),
  }).start();
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
 */
function registerLiveQueries(options: StartRolesOptions): LiveQueryRegistry {
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
async function startSync(
  options: StartRolesOptions,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport: options.runtime.transport, sockets });
  const node = createSyncNode({
    hub,
    registry: registerLiveQueries(options),
    transport: options.runtime.transport,
    buildId: options.buildId,
    sockets,
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

export async function startRoles(options: StartRolesOptions): Promise<RunningRoles> {
  const selected = options.roles;
  // Roles bind sockets in order, so a role that fails to start has to release the ones before it.
  // Without this a failed `sync` leaves the web server bound and unreachable by any caller.
  const started: (() => Promise<void>)[] = [];
  try {
    // First, and for every role rather than only the two that open an HTTP socket: `worker` and
    // `sync` are precisely the roles whose HPAs read a series the process itself has to publish,
    // and a `worker` container with no listener is an HPA pinned at `<unknown>` forever.
    const metrics = startMetricsEndpoint({
      port: options.metricsPort ?? (options.port === 0 ? 0 : DEFAULT_METRICS_PORT),
      ...(options.http === undefined ? {} : { hostname: options.http.hostname }),
    });
    started.push(async () => metrics.stop());

    const server = selected.includes('web') ? startWeb(options) : null;
    if (server !== null) started.push(() => server.stop());

    const sync = selected.includes('sync') ? await startSync(options) : null;
    if (sync !== null) started.push(sync.stop);

    const worker = selected.includes('worker')
      ? createWorker({
          driver: options.runtime.jobs,
          context: () => createContext({ role: 'worker', buildId: options.buildId }),
        })
      : null;
    worker?.start();
    if (worker !== null) started.push(() => worker.stop('x dev stopped'));

    const scheduler = selected.includes('scheduler')
      ? createScheduler({ driver: options.runtime.jobs })
      : null;
    scheduler?.start();
    if (scheduler !== null) started.push(() => scheduler.stop());

    // Last, and only after the transport it publishes to exists: a replicator started ahead of the
    // sync node would decode changes with nothing subscribed to receive them, and the slot it
    // holds is the one resource here another process can be locked out of.
    const replicator = selected.includes('replicator')
      ? await startReplicator({
          services: options.runtime.services,
          env: options.env,
          transport: options.runtime.transport,
        })
      : null;
    if (replicator !== null) started.push(() => replicator.stop());

    return {
      roles: selected,
      url: server === null ? null : server.url(),
      syncUrl: sync?.url ?? null,
      metricsUrl: metrics.url,
      server,
      worker,
      scheduler,
      replicator,
      async stop() {
        // Reverse boot order, so the slot is released before the bus it published to closes.
        await replicator?.stop();
        await scheduler?.stop();
        await worker?.stop('x dev stopped');
        await sync?.stop();
        await server?.stop();
        // Last: a scrape taken while the roles above drain is the one that explains the drain.
        metrics.stop();
      },
    };
  } catch (error) {
    for (const stop of started.reverse()) {
      // The role that refused to start is the failure worth reporting, not a stop on the way out.
      await stop().catch(() => undefined);
    }
    throw error;
  }
}
