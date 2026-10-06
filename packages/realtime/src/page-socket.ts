// The page's ONE socket: built on the first live or channel hook, and shared by every island
// through the page state. Part of the page runtime (`page-runtime.ts`), so no island bundle carries
// the connection lifecycle: a hook reaches it as `services.socket`, off the page object.

import { onRescope, pageClient } from '@ultimat3/core/page';
import { queryClientMethodFor } from '@ultimat3/query/client';
import { LiveClient } from './client';
import { DEFAULT_HEARTBEAT_MS } from './client-heartbeat';
import { peekOutbox } from './outbox-slot';
import { SyncUnconfiguredError } from './page-errors';
import { installedPage } from './page-store';
import {
  openHost,
  type RehostingHost,
  rehosting,
  type SocketHost,
  type SocketHostOptions,
} from './socket-host';
import { pageSyncTarget, syncWorkerFromMeta } from './sync-meta';

/** Get-or-create, and connect on creation. `hook` names the caller in the refusal. */
export function pageSocket(hook: string): LiveClient {
  const page = installedPage(hook);
  // Its one writer is below, so the stored value is always this class — from SOME bundle's copy,
  // which is why it is read structurally and never checked with `instanceof`.
  if (page.socket !== undefined) return page.socket as LiveClient;
  // What the bootstrap passed, else what the document shell rendered into `<head>`.
  const target = page.sync ?? pageSyncTarget();
  if (target === undefined) throw new SyncUnconfiguredError({ hook });
  let host = rehostingFor(pageClient().scope.principal ?? null, target.buildId);
  const client = new LiveClient({
    connect: () => host.socket(target),
    buildId: target.buildId,
    actorId: pageClient().scope.principal ?? null,
    store: page.store,
    // The channel's catch-up read is an ordinary query read: core's transport adopts its records.
    catchUp: (query, params) => queryClientMethodFor(query, { baseUrl: '' })(params),
  });
  page.socket = client;
  pageClient().socket = client;
  // Every time the socket comes (back) up, the writes the network refused go out, in order, over
  // HTTP — the outbox's own idempotency keys make a replay after a lost answer harmless.
  let up = false;
  client.onStatus(() => {
    if (client.connected && !up)
      void peekOutbox()
        ?.replay()
        .catch(() => undefined);
    up = client.connected;
  });
  // After the disk restore, so a restored record is shown before the first frame can race it.
  void page.booted.then(() => client.connect());
  // A new principal gets its own worker — never the previous principal's socket — and redials.
  const offRescope = onRescope((next) => {
    host.bye();
    host = rehostingFor(next.principal ?? null, target.buildId);
    client.connect();
  });
  // `bye` only for a page that is really going: a `pagehide` into the back/forward cache is a page
  // that may come back, and one that said bye came back to a port the engine had released.
  const bye = (event: Event): void => {
    if (Reflect.get(event, 'persisted') !== true) host.bye();
  };
  // ...and a page restored from that cache re-hosts rather than trusting the port it left with.
  const restored = (event: Event): void => {
    if (Reflect.get(event, 'persisted') !== true) return;
    host.rehost();
    client.connect();
  };
  const listens = typeof addEventListener === 'function';
  if (listens) {
    addEventListener('pagehide', bye);
    addEventListener('pageshow', restored);
  }
  teardowns.add(() => {
    offRescope();
    if (listens) {
      removeEventListener('pagehide', bye);
      removeEventListener('pageshow', restored);
    }
    client.close();
    host.bye();
    if (page.socket === client) page.socket = undefined;
    if (pageClient().socket === client) pageClient().socket = undefined;
  });
  return client;
}

/**
 * Every socket this module built, as the undo of building it. A page builds one and never tears it
 * down — the tab's end is its teardown — so only a test process, which builds one per case, calls
 * `resetPageSocket`. Not on the barrel: an app has no page to reset.
 */
const teardowns = new Set<() => void>();

/** Where a page socket gets its host. `openHost` in production; a test hands in its own. */
let hosts: (options: SocketHostOptions) => SocketHost = openHost;

/**
 * For tests: unsubscribe, close and unseat every page socket built so far, so a case starts clean
 * — and, optionally, build the next ones over `openHost` of the case's own. A case that counts
 * dials through the real engine counts every engine alive in the process; one that counts HOSTS
 * counts only what this module asked for, which is the one thing it owns.
 */
export function resetPageSocket(
  options: { readonly openHost?: (options: SocketHostOptions) => SocketHost } = {},
): void {
  for (const teardown of teardowns) teardown();
  teardowns.clear();
  hosts = options.openHost ?? openHost;
}

/** Where `hasPageSocket` lives, re-exported for the callers that reach it from here. */
export { hasPageSocket } from './page-store';

function hostFor(scope: string | null, buildId: string): SocketHost {
  const workerUrl =
    typeof document === 'undefined' || typeof location === 'undefined'
      ? undefined
      : syncWorkerFromMeta(document, location.href);
  return hosts({ workerUrl, scope, buildId });
}

/**
 * The host for one principal, re-made when an `open` goes unanswered for two heartbeats — a port
 * the engine reaped, or a worker that died — rather than leaving the tab dialling a dead port.
 */
function rehostingFor(scope: string | null, buildId: string): RehostingHost {
  return rehosting(() => hostFor(scope, buildId), { openTimeoutMs: 2 * DEFAULT_HEARTBEAT_MS });
}
