// The page runtime: the ONE record store, the socket stack, the query client and core's transport
// behind every hook, installed once per page onto the page object (`page-store.ts`). Never in an
// island: the page boot carries it where the server renders one, and the CLI builds it as the
// runtime chunk an island loads where it does not (`packages/cli/src/island-realtime.ts`).

import { clientTransport, onRescope, pageClient } from '@ultimat3/core/page';
import { queryClientMethodFor } from '@ultimat3/query/client';
import { pageSocket } from './page-socket';
import { type InstalledPage, pageRealtime } from './page-store';
import { RecordStore } from './record-store';

/**
 * Get-or-install, idempotent: the boot and the runtime chunk may both run on one page (a boot that
 * arrived after its island gave up on it), and whichever runs second adopts what the first built.
 * Installs the store as core's `RecordSink`, so every HTTP answer's records land in it.
 */
export function installPageRuntime(): InstalledPage {
  const page = pageRealtime();
  const store = page.store;
  if (store !== undefined && page.services !== undefined) return page as InstalledPage;
  const created = store ?? new RecordStore();
  page.store = created;
  page.services = {
    socket: pageSocket,
    read: (name) => queryClientMethodFor(name, { baseUrl: '' }),
    send: clientTransport,
  };
  pageClient().store = created;
  // A new principal sees nothing of the previous one: every record goes, in memory, at once.
  onRescope(() => created.clear());
  return page as InstalledPage;
}
