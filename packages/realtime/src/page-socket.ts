// The page's ONE socket: built on the first live or channel hook, by whichever island bundle asks
// first, and shared by every other one through the page state. A form-only island never imports
// this module, so it ships none of the connection lifecycle.

import { onRescope, pageClient } from '@ultimat3/core/page';
import { queryClientMethodFor } from '@ultimat3/query/client';
import { LiveClient } from './client';
import { SyncUnconfiguredError } from './page-errors';
import { pageOutbox } from './page-outbox';
import { pageRealtime } from './page-store';
import { openHost, type SocketHost } from './socket-host';
import { pageSyncTarget, syncWorkerFromMeta } from './sync-meta';

/** Get-or-create, and connect on creation. `hook` names the caller in the refusal. */
export function pageSocket(hook: string): LiveClient {
  const page = pageRealtime();
  // Its one writer is below, so the stored value is always this class — from SOME bundle's copy,
  // which is why it is read structurally and never checked with `instanceof`.
  if (page.socket !== undefined) return page.socket as LiveClient;
  // What the bootstrap passed, else what the document shell rendered into `<head>`.
  const target = page.sync ?? pageSyncTarget();
  if (target === undefined) throw new SyncUnconfiguredError({ hook });
  let host = hostFor(pageClient().scope.principal ?? null);
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
      void pageOutbox()
        .replay()
        .catch(() => undefined);
    up = client.connected;
  });
  // After the disk restore, so a restored record is shown before the first frame can race it.
  void page.booted.then(() => client.connect());
  // A new principal gets its own worker — never the previous principal's socket — and redials.
  onRescope((next) => {
    host.bye();
    host = hostFor(next.principal ?? null);
    client.connect();
  });
  if (typeof addEventListener === 'function') addEventListener('pagehide', () => host.bye());
  return client;
}

/**
 * Whether this page holds a socket — `false` on a server render and before any live hook ran.
 * The guard a component with a static fallback asks (an offline banner, an update prompt).
 */
export function hasPageSocket(): boolean {
  const host = globalThis as { [key: symbol]: unknown };
  const page = host[Symbol.for('ultimate.realtime')];
  return (
    typeof page === 'object' && page !== null && (page as { socket?: unknown }).socket !== undefined
  );
}

function hostFor(scope: string | null): SocketHost {
  const workerUrl =
    typeof document === 'undefined' || typeof location === 'undefined'
      ? undefined
      : syncWorkerFromMeta(document, location.href);
  return openHost({ workerUrl, scope });
}
