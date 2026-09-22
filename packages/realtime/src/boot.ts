// `@ultimat3/realtime/boot` — the page's boot, ONE classic script per document (plan 101), built
// and served by the CLI the way the sync worker is. It restores the principal's persisted records
// and opens the outbox, so a reload replays what the previous load queued even on a page whose
// islands only read. Here and not in `page-store.ts`, so no island bundle carries it.

import type { ClientScope } from '@ultimat3/core/page';
import { pageClient } from '@ultimat3/core/page';
import { pageLocalStore, scopeKey } from './local-store-idb';
import { pageOutbox } from './page-outbox';
import { BOOT_KEY, type BootHost, pageRealtime } from './page-store';
import { persistedTypes, recordPersister } from './record-persister';
import type { RecordStore } from './record-store';

/**
 * The types the document marks persisted, read back off disk, then the page's outbox opened. None
 * marked is no record disk.
 */
async function restoreFromDisk(store: RecordStore, principal: Principal): Promise<void> {
  const types = persistedTypes();
  const keep = scopeKey(principal);
  try {
    // A sign-out by full navigation (a form post and a redirect) never calls `rescope()`, so the
    // previous principal's rows and queued writes would outlive it on disk. The boot is the one
    // moment every page load passes: everything not THIS principal's goes, before anything is
    // restored. An unscoped page (rendered for nobody) wipes nothing — it knows no principal.
    // Trade-off: two principals in two tabs of one browser — the newer boot wipes the other's
    // disk; that tab keeps its records in memory and re-persists them on its next write.
    if (keep !== undefined) await (await pageLocalStore()).wipeOthers(keep);
    if (types.size > 0) {
      await recordPersister({ store, local: await pageLocalStore(), types }).restore();
    }
  } catch (error) {
    // A disk the browser refused (quota, a private window) costs the offline copy, never the page.
    console.error(error);
  }
  // The outbox opens with the page, not with the first write or live hook: a reload that holds
  // neither must still replay what the previous load queued (on open, `online`, the SW's drain).
  // After the restore, so a replay settles overlays over the records it restored.
  pageOutbox();
}

type Principal = ClientScope['principal'];

/**
 * Once per page, whoever calls first; the promise is what `pageRealtime().booted` answers. The
 * scope is the page's own — a parameter only so a test can boot an unscoped page (an OBJECT, so an
 * explicit `undefined` principal is not mistaken for "use the default").
 */
export function bootPage(
  scope: { readonly principal: Principal } = pageClient().scope,
): Promise<void> {
  const host = globalThis as BootHost;
  const started = host[BOOT_KEY];
  if (started !== undefined) return started;
  const booted = restoreFromDisk(pageRealtime().store, scope.principal);
  Object.defineProperty(host, BOOT_KEY, { value: booted, configurable: true });
  return booted;
}

// As a page script it runs itself; imported by a test (no DOM) it waits to be called.
if (typeof document !== 'undefined') void bootPage();
