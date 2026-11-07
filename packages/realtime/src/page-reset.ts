// The one test reset of a page's realtime state, for an app's island tests. An island test mounts
// the BUILT chunk, which carries its own copy of this package: module state the test's copy cannot
// see. So this acts on what every copy shares — the page object and the page globals on `globalThis`.

import { pageClient } from '@ultimat3/core/page';
import { OUTBOX_KEY } from './outbox-slot';
import { closePageSockets } from './page-socket';
import { BOOT_KEY, BOOT_RELEASE_KEY, PAGE_KEY, peekPageRealtime } from './page-store';
import { uninstallRealtime } from './reactivity';

/** Every page global the realtime client keeps: the page object, the outbox, the boot's promise. */
const PAGE_KEYS: readonly symbol[] = [PAGE_KEY, OUTBOX_KEY, BOOT_KEY, BOOT_RELEASE_KEY];

/**
 * For tests: the page as no island has touched it. Closes the page socket — whichever bundle's
 * copy built it — drops the page object, the outbox and the boot's promise, and unseats the store
 * and socket from core's page client, so the next case or file starts with no page. Never call it
 * in a browser: a page's state ends with the tab. A host a test handed `resetPageSocket` stays.
 */
export function resetPageRealtime(): void {
  peekPageRealtime()?.closeSocket?.();
  closePageSockets();
  uninstallRealtime();
  for (const key of PAGE_KEYS) Reflect.deleteProperty(globalThis, key);
  const handle = pageClient();
  handle.store = undefined;
  handle.socket = undefined;
}
