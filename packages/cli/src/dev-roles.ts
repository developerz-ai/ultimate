// Running the roles. In production these are separate containers selected by `ROLE`; `x dev`
// runs them in one process by starting the same framework objects each container starts, so a
// job that only works when awaited inline still fails here.
//
// `migrate` and `replicator` are absent on purpose: `migrate` is run-once (`x db apply`) and the
// replicator needs logical replication the embedded database does not serve yet.

import type { Role } from '@ultimat3/core';
import { createContext, isRole, ROLES } from '@ultimat3/core';
import type { Route, ServerHandle } from '@ultimat3/http';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { Scheduler, Worker } from '@ultimat3/jobs';
import { createScheduler, createWorker } from '@ultimat3/jobs';
import {
  ChannelHub,
  createSyncNode,
  LiveQueryRegistry,
  listenSyncNode,
  RingChangeBuffer,
  SocketRegistry,
} from '@ultimat3/realtime';
import { devHooks } from './dev-hooks';
import type { RunningServices } from './dev-runtime';
import { BadFlagError } from './errors';

/** Every role `x dev` can run, in boot order. */
export const DEV_ROLES: readonly Role[] = ['web', 'sync', 'worker', 'scheduler'];

export interface StartRolesOptions {
  readonly roles: readonly Role[];
  readonly port: number;
  readonly buildId: string;
  readonly runtime: RunningServices;
  /** Routes the web role serves: `/_x`, the actions, the pages. */
  readonly routes: readonly Route[];
}

export interface RunningRoles {
  readonly roles: readonly Role[];
  /** `http://…` once the web role is up; null when it was not selected. */
  readonly url: string | null;
  /** Where the sync role accepts websockets; null when it was not selected. */
  readonly syncUrl: string | null;
  readonly server: ServerHandle | null;
  readonly worker: Worker | null;
  readonly scheduler: Scheduler | null;
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
    if (!DEV_ROLES.includes(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" does not run under x dev (it runs ${name === 'migrate' ? 'once, as `x db apply`' : 'against a replicated database'})`,
        fix: `x dev --role ${DEV_ROLES.join(',')}`,
      });
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return DEV_ROLES.filter((role) => selected.includes(role));
}

function startWeb(options: StartRolesOptions): ServerHandle {
  return createServer({
    routes: options.routes,
    role: 'web',
    hooks: devHooks(),
    config: defineHttpConfig({
      port: options.port,
      dev: true,
      buildId: options.buildId,
      hostname: 'localhost',
    }),
  }).start();
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
  const node = createSyncNode({
    hub: new ChannelHub({ transport: options.runtime.transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport: options.runtime.transport,
    buildId: options.buildId,
    sockets,
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

    return {
      roles: selected,
      url: server === null ? null : server.url(),
      syncUrl: sync?.url ?? null,
      server,
      worker,
      scheduler,
      async stop() {
        await scheduler?.stop();
        await worker?.stop('x dev stopped');
        await sync?.stop();
        await server?.stop();
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
